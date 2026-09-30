import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { app } from "../src/worker/index.js";
import { handleScheduled } from "../src/worker/scheduled.js";
import { scorePendingTweets } from "../src/worker/score-queue.js";
import { backfillArticles } from "../src/worker/collect/articles.js";
import type { Env } from "../src/worker/env.js";
import { baseTestEnv, createD1TestDatabase, insertTestTweets } from "./d1-test-db.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const context = { waitUntil() {}, passThroughOnException() {} };

function minute() {
  return { cron: "* * * * *", scheduledTime: Date.now() };
}

function insertTopic(sqlite: DatabaseSync, id: string, version = "v1", question = "video games") {
  sqlite.prepare(`
    INSERT INTO topics (id, label, question, version, sort_order, active)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run(id, id, question, version);
}

function stubJev() {
  const requests: Array<{ state: string; questions: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.x.com/")) {
      return Response.json({ data: [], meta: {} });
    }
    const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, unknown> };
    requests.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]));
    return Response.json({ answers, usage: { input_tokens: 100 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

describe("event-driven scoring triggers", () => {
  it("creates, updates, and clears a rescore key with topic changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
    const { db, sqlite } = createD1TestDatabase();
    const env = baseTestEnv(db);
    const request = (method: string, path: string, body?: unknown) => app.fetch(new Request(`https://archive.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);

    const created = await request("POST", "/api/topics", {
      label: "Games",
      question: "video games",
      timeline_visibility: "public",
      search_visibility: "public",
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { topic: { id: string; version: string } };
    const key = `rescore:${createdBody.topic.id}`;
    expect(JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value as string))
      .toEqual({ version: createdBody.topic.version, cursor: "" });

    vi.advanceTimersByTime(1);
    const changed = await request("PATCH", `/api/topics/${createdBody.topic.id}`, { question: "game development" });
    expect(changed.status).toBe(200);
    const updated = sqlite.prepare("SELECT version FROM topics WHERE id = ?").get(createdBody.topic.id) as { version: string };
    expect(updated.version).not.toBe(createdBody.topic.version);
    expect(JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value as string))
      .toEqual({ version: updated.version, cursor: "" });

    const removed = await request("DELETE", `/api/topics/${createdBody.topic.id}`);
    expect(removed.status).toBe(200);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(key)).toBeUndefined();
  });

  it("ends an idle minute cron after one rescore-key query", async () => {
    const { db, reads } = createD1TestDatabase();

    await handleScheduled(minute(), baseTestEnv(db), context);

    expect(reads).toHaveLength(1);
    expect(reads[0].query.replace(/\s+/g, " ").trim()).toBe(
      "SELECT key, value FROM meta WHERE key >= 'rescore:' AND key < 'rescore;'",
    );
  });

  it("scores newly collected tweets against every active topic in the same 30-minute run", async () => {
    const { db, sqlite } = createD1TestDatabase();
    for (let index = 1; index <= 13; index += 1) insertTopic(sqlite, `topic-${String(index).padStart(2, "0")}`);
    const { requests, fetchMock } = stubJev();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.x.com/")) {
        return Response.json({
          data: Array.from({ length: 5 }, (_, index) => ({
            id: String(1001 + index),
            author_id: "test",
            created_at: "2026-09-29T00:00:00.000Z",
            text: `New synthetic tweet ${index + 1}`,
          })),
          meta: {},
        });
      }
      const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, unknown> };
      requests.push(body);
      return Response.json({
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: 0.9 }])),
        usage: { input_tokens: 100 },
      });
    });

    await handleScheduled({ cron: "*/30 * * * *", scheduledTime: Date.now() }, baseTestEnv(db), context);

    expect(requests).toHaveLength(5);
    expect(requests.every(({ questions }) => Object.keys(questions).length === 13)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 65 });
  });

  it("backfills one 100-ID batch, resolves absent articles, preserves scores, and bumps data_version", async () => {
    const { db, sqlite } = createD1TestDatabase();
    insertTopic(sqlite, "games");
    const insertTweet = sqlite.prepare(`
      INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
      VALUES (?, '2016-01-01T00:00:00.000Z', '2016-01-01', 2016, 1, 'original', ?, 'archive')
    `);
    const insertScore = sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES (?, 'games', 0.4, 'v1')");
    for (let index = 1; index <= 102; index += 1) {
      const id = `article-${String(index).padStart(3, "0")}`;
      insertTweet.run(id, `https://x.com/i/article/${id}`);
      insertScore.run(id);
    }
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('data_version', 'before')").run();
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
      requests.push(url);
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return Response.json({
        data: [
          { id: ids[0], article: { title: "Synthetic article title", plain_text: "Synthetic article body." } },
          { id: ids[1] },
        ],
      });
    };

    const updatedIds = await backfillArticles(baseTestEnv(db), fetchImpl);

    expect(requests).toHaveLength(1);
    expect(requests[0].pathname).toBe("/2/tweets");
    expect(requests[0].searchParams.get("tweet.fields")).toBe("article");
    const requestedIds = (requests[0].searchParams.get("ids") ?? "").split(",");
    expect(requestedIds).toHaveLength(100);
    expect(updatedIds).toEqual([requestedIds[0]]);
    expect(sqlite.prepare("SELECT article_title, article_text FROM tweets WHERE id = ?").get(requestedIds[0]))
      .toEqual({ article_title: "Synthetic article title", article_text: "Synthetic article body." });
    expect(sqlite.prepare("SELECT article_title, article_text FROM tweets WHERE id = ?").get(requestedIds[1]))
      .toEqual({ article_title: "", article_text: "" });
    expect(sqlite.prepare("SELECT article_title, article_text FROM tweets WHERE id = ?").get(requestedIds[2]))
      .toEqual({ article_title: "", article_text: "" });
    expect(sqlite.prepare("SELECT article_title FROM tweets WHERE id = 'article-102'").get())
      .toEqual({ article_title: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 102 });
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).not.toEqual({ value: "before" });
  });

  it("skips article backfill when the X bearer token is absent", async () => {
    const { db } = createD1TestDatabase();
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(backfillArticles(baseTestEnv(db, { X_BEARER_TOKEN: "" } as Partial<Env>), fetchImpl))
      .resolves.toEqual([]);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-scores an article older than seven days with its body in the same 30-minute run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
    const { db, sqlite } = createD1TestDatabase();
    insertTopic(sqlite, "games");
    sqlite.prepare(`
      INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
      VALUES ('old-article', '2025-01-01T00:00:00.000Z', '2025-01-01', 2025, 1, 'original',
        'https://x.com/i/article/old-article', 'archive')
    `).run();
    sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES ('old-article', 'games', 0.2, 'v1')").run();
    const jevRequests: Array<{ state: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "api.x.com" && url.pathname.startsWith("/2/users/")) {
        return Response.json({ data: [], meta: {} });
      }
      if (url.hostname === "api.x.com" && url.pathname === "/2/tweets") {
        return Response.json({ data: [{ id: "old-article", article: {
          title: "Synthetic old article", plain_text: "A subject described only in this article body.",
        } }] });
      }
      const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, unknown> };
      jevRequests.push({ state: body.state });
      return Response.json({
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: 0.9 }])),
        usage: { input_tokens: 100 },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    await handleScheduled({ cron: "*/30 * * * *", scheduledTime: Date.now() }, baseTestEnv(db), context);

    expect(jevRequests).toHaveLength(1);
    expect(jevRequests[0].state).toContain("아티클 제목: Synthetic old article");
    expect(jevRequests[0].state).toContain("아티클 본문: A subject described only in this article body.");
    expect(sqlite.prepare("SELECT article_title, article_text FROM tweets WHERE id = 'old-article'").get())
      .toEqual({ article_title: "Synthetic old article", article_text: "A subject described only in this article body." });
    expect(sqlite.prepare("SELECT score FROM scores WHERE tweet_id = 'old-article' AND topic = 'games'").get())
      .toEqual({ score: 0.9 });
  });

  it("processes one rescore batch, advances its cursor, and removes a short final batch", async () => {
    const { db, sqlite } = createD1TestDatabase();
    insertTopic(sqlite, "games");
    insertTestTweets(sqlite, 3);
    sqlite.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run("rescore:games", JSON.stringify({ version: "v1", cursor: "" }));
    const { requests } = stubJev();
    const env = baseTestEnv(db, { SCORE_BATCH: "2" } as Partial<Env>);

    await handleScheduled(minute(), env, context);
    const afterFirst = JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = 'rescore:games'").get()?.value as string);
    expect(afterFirst).toEqual({ version: "v1", cursor: "tweet-0002" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 2 });

    await handleScheduled(minute(), env, context);

    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'rescore:games'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 3 });
    expect(requests).toHaveLength(3);
    expect(requests.every(({ questions }) => Object.keys(questions).join(",") === "games")).toBe(true);
  });

  it("discards a rescore task whose version no longer matches the topic", async () => {
    const { db, sqlite } = createD1TestDatabase();
    insertTopic(sqlite, "games", "v2");
    sqlite.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run("rescore:games", JSON.stringify({ version: "v1", cursor: "" }));
    const { requests } = stubJev();

    await handleScheduled(minute(), baseTestEnv(db), context);

    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'rescore:games'").get()).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("retries only unscored tweets from the previous seven days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
    const { db, sqlite, reads } = createD1TestDatabase();
    insertTopic(sqlite, "games");
    const insert = sqlite.prepare(`
      INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
      VALUES (?, ?, ?, 2024, 1, 'original', ?, 'archive')
    `);
    insert.run("recent", "2026-09-23T00:00:00.000Z", "2026-09-23", "Recent pending");
    insert.run("old", "2026-09-20T00:00:00.000Z", "2026-09-20", "Old pending");
    const { requests } = stubJev();

    const result = await scorePendingTweets(baseTestEnv(db, { SCORE_BATCH: "10" } as Partial<Env>));

    expect(result.scored).toBe(1);
    expect(requests).toHaveLength(1);
    expect(sqlite.prepare("SELECT tweet_id FROM scores").all()).toEqual([{ tweet_id: "recent" }]);
    const query = reads.find(({ query: value }) => value.includes("created_at >="));
    expect(query).toBeDefined();
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query?.query}`).all(...(query?.values ?? []) as []) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("tweets_created"))).toBe(true);
  });
});
