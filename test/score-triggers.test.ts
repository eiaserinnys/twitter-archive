import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { app } from "../src/worker/index.js";
import { handleScheduled } from "../src/worker/scheduled.js";
import { scorePendingTweets } from "../src/worker/score-queue.js";
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
