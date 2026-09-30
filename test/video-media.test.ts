import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import { createMediaBucket } from "../src/node/files.js";
import { normalizeArchive } from "../src/archive/normalize.js";
import { readArchiveScripts } from "../src/archive/archive-reader.js";
import { collectNewTweets } from "../src/worker/collect/index.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";
import type { Env } from "../src/worker/env.js";
import { mediaBody, uploadArticleCover } from "../src/worker/collect/media.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "archive-video-")); dirs.push(dir); return dir; }

it("serves complete and partial media through the Node bucket and shared route", async () => {
  const media = createMediaBucket(await directory());
  const stream = new Response("0123456789").body!;
  await media.put("media/1/video.mp4", stream);
  const env = { DEV_OWNER: "1", MEDIA: media } as never;
  for (const [range, expected, contentRange] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-3", "789", "bytes 7-9/10"]]) {
    const response = await app.request("/media/media/1/video.mp4", { headers: { Range: range } }, env);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(expected.length));
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(await response.text()).toBe(expected);
  }
  const complete = await app.request("/media/media/1/video.mp4", {}, env);
  expect(complete.status).toBe(200);
  expect(complete.headers.get("Accept-Ranges")).toBe("bytes");
  expect(await complete.text()).toBe("0123456789");
  for (const range of ["bytes=5-2", "bytes=30-", "bytes=0-1,4-5", "nonsense", "bytes=-0"]) {
    const response = await app.request("/media/media/1/video.mp4", { headers: { Range: range } }, env);
    expect(response.status).toBe(416);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  }
});

it("passes the requested range to R2 and preserves unrelated storage failures", async () => {
  const get = vi.fn(async () => ({ body: new Response("23").body, size: 10, range: { offset: 2, length: 2 }, writeHttpMetadata() {} }));
  const env = { DEV_OWNER: "1", MEDIA: { get } } as never;
  expect((await app.request("/media/video.mp4", { headers: { Range: "bytes=2-3" } }, env)).status).toBe(206);
  expect(get).toHaveBeenCalledWith("video.mp4", { range: { offset: 2, length: 2 } });
  get.mockRejectedValueOnce(new Error("R2 GET failed: (10039) The requested range is not satisfiable"));
  expect((await app.request("/media/video.mp4", { headers: { Range: "bytes=20-" } }, env)).status).toBe(416);
  get.mockRejectedValueOnce(new Error("storage unavailable"));
  expect((await app.request("/media/video.mp4", { headers: { Range: "bytes=2-3" } }, env)).status).toBe(500);
});

it.each(["photo", "video", "animated_gif"])("streams collected %s with a known response length", async type => {
  const { db, sqlite } = createD1TestDatabase();
  const response = new Response("media bytes", { headers: { "Content-Length": "11", "Content-Type": type === "photo" ? "image/jpeg" : "video/mp4" } });
  const body = response.body;
  const arrayBuffer = vi.spyOn(response, "arrayBuffer");
  const put = vi.fn<Env["MEDIA"]["put"]>(async () => undefined);
  try {
    await collectNewTweets(baseTestEnv(db, { X_USER_ID: "self", MEDIA: { get: async () => null, put } }), async input =>
      String(input).startsWith("https://api.x.com/") ? Response.json({
        data: [{ id: "101", text: "Media", created_at: "2024-01-01T00:00:00Z", attachments: { media_keys: ["m"] } }],
        includes: { media: [{ media_key: "m", type, url: "https://media.test/photo.jpg", variants: [{ content_type: "video/mp4", bit_rate: 100, url: "https://media.test/video.mp4" }] }] },
      }) : response);
    expect(put.mock.calls[0]?.[1]).toBe(body);
    expect(arrayBuffer).not.toHaveBeenCalled();
  } finally { sqlite.close(); }
});

async function archive(dir: string) {
  const tweets = ["video", "animated_gif", "video"].map((type, idx) => ({ tweet: {
    id_str: String(101 + idx), full_text: type, created_at: "2024-01-01T00:00:00Z",
    extended_entities: { media: [{ type, media_url_https: "https://media.test/preview.jpg", video_info: { variants: [
      { content_type: "application/x-mpegURL", url: "https://media.test/master.m3u8" },
      { content_type: "video/mp4", bitrate: 10, url: "https://media.test/low.mp4" },
      { content_type: "video/mp4", bitrate: 100, url: `https://media.test/${type}.mp4?tag=1` },
    ] } }] },
  } }));
  const path = join(dir, "synthetic.zip");
  await writeFile(path, zipSync({
    "data/account.js": strToU8('window.YTD.account.part0 = [{"account":{"accountId":"self","username":"test"}}];'),
    "data/tweets.js": strToU8(`window.YTD.tweets.part0 = ${JSON.stringify(tweets)};`),
    "data/tweets_media/101-video.mp4": strToU8("video bytes"),
    "data/tweets_media/102-animated_gif.mp4": strToU8("gif bytes"),
  }));
  return path;
}

it("maps video and GIF archive members to the highest bitrate mp4", async () => {
  const zip = await archive(await directory());
  const rows = normalizeArchive(await readArchiveScripts(zip));
  expect(rows.slice(0, 2).map(row => row.media[0].archive_path)).toEqual(["data/tweets_media/101-video.mp4", "data/tweets_media/102-animated_gif.mp4"]);
});

it("repairs zip media locally, skips missing candidates and writes applicable SQL", async () => {
  const { runRepairArchiveMedia } = await import("../scripts/repair-archive-media.js");
  const dir = await directory(); const zip = await archive(dir);
  const inputPath = join(dir, "candidates.json");
  await writeFile(inputPath, JSON.stringify([{ results: [
    { tweet_id: "101", idx: 0, type: "video" }, { tweet_id: "102", idx: 0, type: "animated_gif" }, { tweet_id: "404", idx: 0, type: "video" }, { tweet_id: "103", idx: 0, type: "video" },
  ] }]));
  const outDir = join(dir, "repaired");
  const result = await runRepairArchiveMedia({ archive: zip, inputPath, outDir });
  expect(result.repaired).toBe(2); expect(result.missingIds).toEqual(["404", "103"]);
  expect(await readFile(join(outDir, "media/101/101-video.mp4"), "utf8")).toBe("video bytes");
  expect(await readFile(join(outDir, "media/102/102-animated_gif.mp4"), "utf8")).toBe("gif bytes");
  const sql = await readFile(result.sqlPath, "utf8");
  expect(sql).toContain("UPDATE media SET r2_key = 'media/101/101-video.mp4' WHERE tweet_id = '101' AND idx = 0;");
  expect(sql).not.toContain("'404'"); expect(sql).toContain("'data_version'");
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("CREATE TABLE media (tweet_id TEXT, idx INTEGER, r2_key TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO media VALUES ('101', 0, NULL), ('102', 0, NULL), ('103', 0, NULL);");
    sqlite.exec(sql);
    expect(sqlite.prepare("SELECT tweet_id, r2_key FROM media ORDER BY tweet_id").all()).toEqual([
      { tweet_id: "101", r2_key: "media/101/101-video.mp4" }, { tweet_id: "102", r2_key: "media/102/102-animated_gif.mp4" }, { tweet_id: "103", r2_key: null },
    ]);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).toBeDefined();
  } finally { sqlite.close(); }
});

it("streams article covers and buffers responses without a known length", async () => {
  const response = new Response("cover", { headers: { "Content-Length": "5", "Content-Type": "image/jpeg" } });
  const put = vi.fn<Env["MEDIA"]["put"]>(async () => undefined);
  await uploadArticleCover({ MEDIA: { put } } as unknown as Env, "101", "https://media.test/cover.jpg", async () => response);
  expect(put.mock.calls[0][1]).toBe(response.body);
  const buffered = await mediaBody(new Response("unknown length"));
  expect(buffered).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(buffered as ArrayBuffer)).toBe("unknown length");
});
