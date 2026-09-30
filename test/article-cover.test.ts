import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { collectNewTweets } from "../src/worker/collect/index.js";
import { backfillArticles } from "../src/worker/collect/articles.js";
import { queryTweets, getOnThisDayTweets, serializeTweetRows } from "../src/worker/db/tweets.js";
import { findCandidates } from "../src/worker/search/candidates.js";
import type { Viewer } from "../src/worker/auth.js";
import type { Env } from "../src/worker/env.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

const coverUrl = "https://pbs.twimg.com/media/synthetic-cover?format=png&name=large";
function payload(cover: boolean) {
  return {
    data: [{ id: "101", author_id: "self", created_at: "2024-01-01T00:00:00.000Z", text: "Synthetic post",
      article: { title: "Synthetic title", plain_text: "Synthetic body", ...(cover ? { cover_media: "3_synthetic" } : {}) } }],
    includes: { media: [{ media_key: "3_synthetic", type: "photo", url: coverUrl, width: 1536, height: 1024 }] },
  };
}

describe.each(["collection", "backfill"] as const)("article cover %s", (path) => {
  it.each(["stored", "HTTP failure", "network failure", "storage failure", "absent"])("continues with cover %s", async (outcome) => {
    const { db, sqlite } = createD1TestDatabase();
    if (path === "backfill") sqlite.exec(`INSERT INTO tweets
      (id, created_at, date_kst, year, month, kind, text, source, article_title)
      VALUES ('101', '2024-01-01T00:00:00.000Z', '2024-01-01', 2024, 1, 'original', 'Synthetic post', 'archive', NULL)`);
    const put = vi.fn<Env["MEDIA"]["put"]>(async () => { if (outcome === "storage failure") throw new Error("Synthetic storage failure"); });
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input)); requests.push(url);
      if (url.hostname === "api.x.com") return Response.json(payload(outcome !== "absent"));
      if (url.href !== coverUrl) throw new Error(`Unexpected URL ${url}`);
      if (outcome === "network failure") throw new Error("Synthetic network failure");
      return new Response("synthetic image bytes", { status: outcome === "HTTP failure" ? 503 : 200,
        headers: { "content-type": "image/png" } });
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const env = baseTestEnv(db, { X_USER_ID: "self", MEDIA: { get: async () => null, put } });
      expect(await (path === "collection" ? collectNewTweets : backfillArticles)(env, fetchImpl)).toEqual(["101"]);
      expect(sqlite.prepare("SELECT article_title, article_text, article_cover_key FROM tweets WHERE id = '101'").get())
        .toEqual({ article_title: "Synthetic title", article_text: "Synthetic body",
          article_cover_key: outcome === "stored" ? "media/101/article-cover.png" : null });
      expect(requests[0].searchParams.get("expansions")?.split(",")).toContain("article.cover_media");
      expect(requests[0].searchParams.get("media.fields")?.split(",")).toEqual(expect.arrayContaining(["url", "width", "height"]));
      expect(put).toHaveBeenCalledTimes(["stored", "storage failure"].includes(outcome) ? 1 : 0);
      if (outcome === "stored") {
        expect(put.mock.calls[0]).toEqual(["media/101/article-cover.png", expect.any(ArrayBuffer),
          { httpMetadata: { contentType: "image/png" } }]);
        expect(new TextDecoder().decode(put.mock.calls[0][1] as ArrayBuffer)).toBe("synthetic image bytes");
      }
      expect(error).toHaveBeenCalledTimes(outcome.includes("failure") ? 1 : 0);
    } finally { error.mockRestore(); sqlite.close(); }
  });
});

it("0007 requeues populated articles while preserving ordinary posts and the partial index", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort();
    for (const name of names.filter(name => name < "0007")) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    sqlite.exec(`INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source, article_title, article_text)
      VALUES ('101', '2024-01-01T00:00:00.000Z', '2024-01-01', 2024, 1, 'original', 'Synthetic post', 'archive', 'Existing title', 'Existing body'),
      ('102', '2024-01-01T01:00:00.000Z', '2024-01-01', 2024, 1, 'original', 'Ordinary post', 'archive', '', '')`);
    sqlite.exec(readFileSync(new URL("../migrations/0007_article_cover.sql", import.meta.url), "utf8"));
    expect(sqlite.prepare("SELECT id FROM tweets WHERE article_title IS NULL").all()).toEqual([{ id: "101" }]);
    expect(sqlite.prepare("SELECT article_text, article_cover_key FROM tweets WHERE id = '101'").get())
      .toEqual({ article_text: "Existing body", article_cover_key: null });
    expect(sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM tweets WHERE article_title IS NULL ORDER BY created_at, id LIMIT 100")
      .all().some(row => String(row.detail).includes("tweets_article_unchecked"))).toBe(true);
  } finally { sqlite.close(); }
});

it.each(["owner", "visitor"] as const)("preserves API cover in timeline, on-this-day and search for %s", async (viewingAs) => {
  const { db, sqlite } = createD1TestDatabase();
  const viewer: Viewer = { owner: viewingAs === "owner", viewingAs };
  try {
    sqlite.exec(`INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source, article_title, article_text, article_cover_key)
      VALUES ('101', '2024-01-01T00:00:00.000Z', '2024-01-01', 2024, 1, 'original', 'Synthetic post', 'api', 'Synthetic title', 'Synthetic body', 'media/101/article-cover.png'),
      ('102', '2024-01-01T01:00:00.000Z', '2024-01-01', 2024, 1, 'original', 'Synthetic post', 'api', 'No cover', 'Synthetic body', NULL)`);
    const list = await queryTweets(db, viewer, { order: "asc", limit: 10 });
    const today = await serializeTweetRows(db, await getOnThisDayTweets(db, ["2024-01-01"], viewer), viewer);
    const search = await serializeTweetRows(db, await findCandidates(db, viewer, { q: "Synthetic", strategies: ["words"], topicCoordinates: [] }), viewer);
    for (const tweets of [list.tweets, today, search]) {
      expect(tweets.find(tweet => tweet.id === "101")?.article).toEqual({ title: "Synthetic title", text: "Synthetic body", cover: "/media/media/101/article-cover.png" });
      expect(tweets.find(tweet => tweet.id === "102")?.article).toEqual({ title: "No cover", text: "Synthetic body", cover: null });
    }
  } finally { sqlite.close(); }
});
