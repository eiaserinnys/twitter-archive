import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SetupRuntime } from "../scripts/lib/setup/runtime.js";
import { readInstanceConfig } from "../scripts/lib/setup/config.js";
import { setupNode } from "../scripts/lib/setup/node.js";
import { createMediaBucket } from "../src/node/files.js";
import { createD1Database } from "../src/node/d1-sqlite.js";
import { collectNewTweets } from "../src/worker/collect/index.js";
import type { Env } from "../src/worker/env.js";
import { writeSyntheticArchive } from "./fixtures.js";

const temporaryDirectories: string[] = [];
const instanceDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all([...temporaryDirectories.splice(0), ...instanceDirectories.splice(0)]
    .map((directory) => rm(directory, { recursive: true, force: true })));
});

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(input instanceof Request ? input.url : input);
}

async function startFakeJev(): Promise<{ baseUrl: string; states: string[] }> {
  const states: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/systemone" ||
      request.headers.authorization !== "Bearer synthetic-jev-key") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { state: string; questions: Record<string, unknown> };
      states.push(payload.state);
      const answers = Object.fromEntries(Object.keys(payload.questions).map((id) => [
        id,
        { noul: id === "games" ? 0.91 : 0.2 },
      ]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers, usage: { input_tokens: 100 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Jev server did not bind a TCP port.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, states };
}

it("keeps owner settings and media usable when an archive is installed after API collection", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const instanceName = "archive-after-collect-" + randomUUID().replaceAll("-", "").slice(0, 12);
  const instanceDirectory = join(repoRoot, "instances", instanceName);
  instanceDirectories.push(instanceDirectory);
  const directory = await mkdtemp(join(tmpdir(), "archive-after-collect-"));
  temporaryDirectories.push(directory);
  const archive = join(directory, "synthetic.zip");
  await writeSyntheticArchive(archive);

  const fakeJev = await startFakeJev();
  const runtime = new SetupRuntime(repoRoot, false, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TYPESAFE_BASE_URL: fakeJev.baseUrl,
    TYPESAFE_API_KEY: "synthetic-jev-key",
    X_BEARER_TOKEN: "synthetic-x-token",
  });
  const templateVars = { X_USER_ID: "1" };

  await setupNode(runtime, instanceName, readInstanceConfig({
    worker_name: instanceName,
    target: "node",
    score_max_usd: 0,
    vars: templateVars,
  }), templateVars);

  const sqlitePath = join(instanceDirectory, "runtime", "archive.sqlite");
  const mediaDirectory = join(instanceDirectory, "runtime", "media");
  const firstApiRequests: URL[] = [];
  const firstFetch: typeof fetch = async (input) => {
    const url = requestUrl(input);
    if (url.hostname === "api.x.com") {
      firstApiRequests.push(url);
      return Response.json({
        data: [
          {
            id: "106",
            author_id: "1",
            created_at: "2026-09-29T10:00:00.000Z",
            text: "A collected recent post",
          },
          {
            id: "107",
            author_id: "1",
            created_at: "2026-09-29T11:00:00.000Z",
            text: "A collected post with a photo",
            attachments: { media_keys: ["collected-photo"] },
          },
        ],
        includes: {
          media: [{
            media_key: "collected-photo",
            type: "photo",
            url: "https://pbs.twimg.com/media/collected.png?format=png",
          }],
        },
        meta: {},
      });
    }
    if (url.hostname === "pbs.twimg.com") return new Response("synthetic-api-photo");
    throw new Error(`Unexpected first-collection request: ${url.href}`);
  };

  const sqlite = new DatabaseSync(sqlitePath);
  let initialIds: string[] = [];
  let collectedMediaKey: string | null = null;
  try {
    const media = createMediaBucket(mediaDirectory);
    const env = { DB: createD1Database(sqlite), MEDIA: media, X_USER_ID: "1", X_BEARER_TOKEN: "synthetic-x-token" } as unknown as Env;
    initialIds = await collectNewTweets(env, firstFetch);
    collectedMediaKey = (sqlite.prepare("SELECT r2_key FROM media WHERE tweet_id = '107' AND idx = 0").get() as { r2_key: string | null }).r2_key;
    sqlite.prepare("UPDATE tweets SET visibility = 'private' WHERE id = '107'").run();
    sqlite.prepare("UPDATE topics SET public_hide_threshold = 0.61 WHERE id = 'games'").run();
  } finally {
    sqlite.close();
  }

  await setupNode(runtime, instanceName, readInstanceConfig({
    worker_name: instanceName,
    target: "node",
    archive,
    score_max_usd: 2,
    vars: templateVars,
  }), templateVars);

  const finalDb = new DatabaseSync(sqlitePath);
  try {
    const media = createMediaBucket(mediaDirectory);
    const maxTweetId = (finalDb.prepare("SELECT value FROM meta WHERE key = 'max_tweet_id'").get() as { value: string }).value;
    const tweetCounts = finalDb.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distinct_count FROM tweets").get() as {
      total: number;
      distinct_count: number;
    };
    const ownerSettings = finalDb.prepare(`
      SELECT tweets.visibility, topics.public_hide_threshold
      FROM tweets CROSS JOIN topics
      WHERE tweets.id = '107' AND topics.id = 'games'
    `).get() as { visibility: string; public_hide_threshold: number };
    const archivedTweetCount = (finalDb.prepare("SELECT COUNT(*) AS count FROM tweets WHERE id = '101'").get() as { count: number }).count;
    const oldTweetScore = finalDb.prepare("SELECT score FROM scores WHERE tweet_id = '101' AND topic = 'games'").get() as { score: number } | undefined;
    const archiveMediaKey = (finalDb.prepare("SELECT r2_key FROM media WHERE tweet_id = '107' AND idx = 0").get() as { r2_key: string | null }).r2_key;
    const archiveMedia = archiveMediaKey ? await media.get(archiveMediaKey) : null;
    const archiveMediaText = archiveMedia ? await new Response(archiveMedia.body).text() : null;

    let nextSinceId: string | null = null;
    const nextFetch: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname !== "api.x.com") throw new Error(`Unexpected next-collection request: ${url.href}`);
      nextSinceId = url.searchParams.get("since_id");
      const alreadyArchivedTweet = !nextSinceId || BigInt(nextSinceId) < 108n;
      return Response.json({
        data: alreadyArchivedTweet ? [{
          id: "108",
          author_id: "1",
          created_at: "2026-09-30T00:00:00.000Z",
          text: "Already present in the archive",
        }] : [],
        meta: {},
      });
    };
    const nextIds = await collectNewTweets({
      DB: createD1Database(finalDb),
      MEDIA: media,
      X_USER_ID: "1",
      X_BEARER_TOKEN: "synthetic-x-token",
    } as unknown as Env, nextFetch);

    expect.soft(firstApiRequests).toHaveLength(1);
    expect.soft(firstApiRequests[0].searchParams.has("since_id")).toBe(false);
    expect.soft(initialIds).toEqual(["106", "107"]);
    expect.soft(collectedMediaKey).toBe("media/107/1.png");
    expect.soft(tweetCounts).toEqual({ total: 7, distinct_count: 7 });
    expect.soft(archivedTweetCount).toBe(1);
    expect.soft(ownerSettings).toEqual({ visibility: "private", public_hide_threshold: 0.61 });
    expect.soft(archiveMediaKey).not.toBe(collectedMediaKey);
    expect.soft(archiveMediaText).toBe("synthetic-photo-2");
    expect.soft(maxTweetId).toBe("108");
    expect.soft(fakeJev.states).toHaveLength(7);
    expect.soft(oldTweetScore?.score).toBe(0.91);
    expect.soft(nextSinceId).toBe("108");
    expect.soft(nextIds).toEqual([]);
  } finally {
    finalDb.close();
  }
});
