import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOPIC_SEED } from "../src/shared/topics.js";
import { app } from "../src/worker/index.js";
import { findCandidates } from "../src/worker/search/candidates.js";
import { buildSql } from "../scripts/load-d1.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

const visitor = { owner: false, viewingAs: "visitor" as const };

beforeEach(() => {
  const entries = new Map<string, Response>();
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => entries.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { entries.set(key.url, response.clone()); },
  } });
});

afterEach(() => vi.unstubAllGlobals());

function publicHideFixture() {
  const { db, sqlite } = createD1TestDatabase();
  sqlite.prepare(`
    INSERT INTO topics (id, label, question, version, sort_order, active,
      timeline_visibility, search_visibility, public_hide_threshold)
    VALUES ('sensitive', '민감', '논쟁적 주장이나 의견', 'current', 1, 1, 'public', 'public', 0.5)
  `).run();
  sqlite.prepare(`
    INSERT INTO topics (id, label, question, version, sort_order, active,
      timeline_visibility, search_visibility, public_hide_threshold)
    VALUES ('games', '게임', '게임에 관한 이야기', 'current', 2, 1, 'public', 'public', NULL)
  `).run();
  const addTweet = sqlite.prepare(`
    INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
    VALUES (?, ?, ?, ?, ?, 'original', ?, 'archive')
  `);
  addTweet.run("hidden-shared", "2024-06-15T00:00:00.000Z", "2024-06-15", 2024, 6, "needle hidden-shared");
  addTweet.run("ordinary-shared", "2024-06-15T01:00:00.000Z", "2024-06-15", 2024, 6, "needle ordinary-shared");
  addTweet.run("hidden-only", "2023-06-15T00:00:00.000Z", "2023-06-15", 2023, 6, "needle hidden-only");
  const addScore = sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES (?, ?, ?, ?)");
  addScore.run("hidden-shared", "sensitive", 0.9, "old-version");
  addScore.run("hidden-only", "sensitive", 0.8, "old-version");
  addScore.run("ordinary-shared", "games", 0.9, "current");
  return { db, sqlite };
}

function request(path: string, env: ReturnType<typeof baseTestEnv>, init?: RequestInit) {
  return app.fetch(new Request(`https://archive.test${path}`, init), env);
}

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

describe("public hide query paths", () => {
  it("removes hidden tweets from date lists and every visitor count surface", async () => {
    const { db } = publicHideFixture();
    const env = baseTestEnv(db, { SOURCE_URL: "https://github.com/eiaserinnys/twitter-archive" });
    const byDate = await body<{ tweets: Array<{ id: string }>; total: number }>(await request("/api/tweets?date=2024-06-15&as=visitor", env));
    expect(byDate).toEqual({ tweets: [expect.objectContaining({ id: "ordinary-shared" })], next_cursor: null, total: 1 });
    expect(byDate.tweets[0]).not.toHaveProperty("visibility");
    expect(byDate.tweets[0]).not.toHaveProperty("public_hidden");

    const byMonth = await body<{ tweets: Array<{ id: string }>; total: number }>(await request("/api/tweets?year=2024&month=6&as=visitor", env));
    expect(byMonth.total).toBe(1);
    expect(byMonth.tweets.map(({ id }) => id)).toEqual(["ordinary-shared"]);

    const byRange = await body<{ tweets: Array<{ id: string }>; total: number }>(await request("/api/tweets?from=2023-06-15&to=2024-06-15&as=visitor", env));
    expect(byRange.total).toBe(1);
    expect(byRange.tweets.map(({ id }) => id)).toEqual(["ordinary-shared"]);

    const emptyHiddenDay = await body<{ tweets: unknown[]; total: number }>(await request("/api/tweets?date=2023-06-15&as=visitor", env));
    expect(emptyHiddenDay).toMatchObject({ tweets: [], total: 0 });

    const sharedCalendar = await body<{ days: Array<{ date: string; total: number; top_topic: string | null }> }>(await request("/api/calendar?year=2024&month=6&as=visitor", env));
    expect(sharedCalendar.days).toEqual([{ date: "2024-06-15", total: 1, top_topic: "games" }]);
    const hiddenCalendar = await body<{ days: unknown[] }>(await request("/api/calendar?year=2023&month=6&as=visitor", env));
    expect(hiddenCalendar.days).toEqual([]);

    const timeline = await body<{ years: Array<{ year: number; total: number; counts: Record<string, number> }> }>(await request("/api/timeline?as=visitor", env));
    expect(timeline.years).toEqual([{ year: 2024, total: 1, counts: { games: 1 } }]);
    const sharedMonth = await body<{ months: Array<{ month: number; total: number; counts: Record<string, number> }> }>(await request("/api/timeline/2024?as=visitor", env));
    expect(sharedMonth.months[5]).toEqual({ month: 6, total: 1, counts: { games: 1 } });
    const hiddenYear = await body<{ months: Array<{ month: number; total: number; counts: Record<string, number> }> }>(await request("/api/timeline/2023?as=visitor", env));
    expect(hiddenYear.months[5]).toEqual({ month: 6, total: 0, counts: {} });

    const onThisDay = await body<{ years: Array<{ year: number; date: string; total: number; tweets: Array<{ id: string }> }> }>(await request("/api/on-this-day?md=06-15&as=visitor", env));
    expect(onThisDay.years).toEqual([{ year: 2024, date: "2024-06-15", distance_days: 0, total: 1, tweets: [expect.objectContaining({ id: "ordinary-shared" })] }]);

    const meta = await body<Record<string, unknown>>(await request("/api/meta?as=visitor", env));
    expect(meta).toMatchObject({ total_tweets: 1, first_date: "2024-06-15", last_date: "2024-06-15", source_url: "https://github.com/eiaserinnys/twitter-archive" });
    expect(meta).not.toHaveProperty("public_hidden_count");
    const ownerMeta = await body<Record<string, unknown>>(await request("/api/meta", env));
    expect(ownerMeta).toMatchObject({ total_tweets: 3, public_hidden_count: 2 });

    const candidates = await findCandidates(db, visitor, { q: "needle", strategies: ["words"], topicCoordinates: [] });
    expect(candidates.map(({ id }) => id)).toEqual(["ordinary-shared"]);
  });

  it("lets owners filter hidden tweets and override or clear per-tweet visibility", async () => {
    const { db, sqlite } = publicHideFixture();
    const ownerEnv = baseTestEnv(db);
    const allOwnerTweets = await body<{ tweets: Array<{ id: string; visibility: string | null; public_hidden: boolean }>; total: number }>(await request("/api/tweets", ownerEnv));
    expect(allOwnerTweets.total).toBe(3);
    expect(allOwnerTweets.tweets.map(({ id }) => id).sort()).toEqual(["hidden-only", "hidden-shared", "ordinary-shared"]);
    expect(allOwnerTweets.tweets.every((tweet) => typeof tweet.public_hidden === "boolean")).toBe(true);
    const hidden = await body<{ tweets: Array<{ id: string; visibility: string | null; public_hidden: boolean }>; total: number }>(await request("/api/tweets?public_hidden=1", ownerEnv));
    expect(hidden.total).toBe(2);
    expect(hidden.tweets.map(({ id }) => id).sort()).toEqual(["hidden-only", "hidden-shared"]);
    expect(hidden.tweets.every((tweet) => tweet.visibility === null && tweet.public_hidden)).toBe(true);

    const visitorWithOwnerFilter = await body<{ tweets: Array<{ id: string }>; total: number }>(await request("/api/tweets?public_hidden=1&as=visitor", ownerEnv));
    expect(visitorWithOwnerFilter.total).toBe(1);
    expect(visitorWithOwnerFilter.tweets.map(({ id }) => id)).toEqual(["ordinary-shared"]);

    const beforeVersion = sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get() as { value?: string } | undefined;
    const madePublic = await request("/api/tweets/hidden-shared", ownerEnv, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "public" }),
    });
    expect(madePublic.status).toBe(200);
    expect(await body(madePublic)).toMatchObject({ visibility: "public", public_hidden: false });
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).not.toEqual(beforeVersion);
    const nowVisible = await body<{ tweets: Array<{ id: string }>; total: number }>(await request("/api/tweets?date=2024-06-15&as=visitor", ownerEnv));
    expect(nowVisible.total).toBe(2);
    expect(nowVisible.tweets.map(({ id }) => id)).toEqual(["hidden-shared", "ordinary-shared"]);

    const restoredAuto = await request("/api/tweets/hidden-shared", ownerEnv, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: null }),
    });
    expect(await body(restoredAuto)).toMatchObject({ visibility: null, public_hidden: true });

    const madePrivate = await request("/api/tweets/ordinary-shared", ownerEnv, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "private" }),
    });
    expect(await body(madePrivate)).toMatchObject({ visibility: "private", public_hidden: true });

    const actualVisitor = baseTestEnv(db, { DEV_OWNER: "" });
    expect((await request("/api/tweets/ordinary-shared", actualVisitor, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "public" }),
    })).status).toBe(403);
    expect((await request("/api/tweets/missing", ownerEnv, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "public" }),
    })).status).toBe(404);
    expect((await request("/api/tweets/ordinary-shared", ownerEnv, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "hidden" }),
    })).status).toBe(400);
  });

  it("stores topic thresholds without queuing a rescore and exposes them to owners", async () => {
    const { db, sqlite } = publicHideFixture();
    const env = baseTestEnv(db);
    const before = sqlite.prepare("SELECT version FROM topics WHERE id = 'sensitive'").get() as { version: string };
    const beforeDataVersion = sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get();
    const patched = await request("/api/topics/sensitive", env, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_hide_threshold: 0.75 }),
    });
    expect(patched.status).toBe(200);
    expect(await body(patched)).toMatchObject({ topic: { public_hide_threshold: 0.75 }, rescored: false });
    expect(sqlite.prepare("SELECT version FROM topics WHERE id = 'sensitive'").get()).toEqual(before);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).not.toEqual(beforeDataVersion);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'rescore:sensitive'").get()).toBeUndefined();

    const created = await request("/api/topics", env, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "추가", question: "추가 주제", timeline_visibility: "public", search_visibility: "public", public_hide_threshold: 0.4 }),
    });
    expect(created.status).toBe(201);
    expect(await body(created)).toMatchObject({ topic: { public_hide_threshold: 0.4 } });
    expect((await request("/api/topics/sensitive", env, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_hide_threshold: null }),
    })).status).toBe(200);
    expect((await request("/api/topics/sensitive", env, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_hide_threshold: 1.1 }),
    })).status).toBe(400);

    const ownerMeta = await body<{ public_hidden_count: number; topics: Array<{ id: string; public_hide_threshold?: number | null }> }>(await request("/api/meta", env));
    expect(ownerMeta.public_hidden_count).toBe(0);
    expect(ownerMeta.topics.find(({ id }) => id === "sensitive")?.public_hide_threshold).toBeNull();
    const visitorMeta = await body<{ topics: Array<Record<string, unknown>> }>(await request("/api/meta?as=visitor", env));
    expect(visitorMeta.topics.find(({ id }) => id === "sensitive")).not.toHaveProperty("public_hide_threshold");
    expect(visitorMeta).toHaveProperty("source_url", null);
  });

  it("seeds the sensitive threshold and writes thresholds through load-d1", () => {
    expect(TOPIC_SEED.topics.find(({ id }) => id === "sensitive")).toMatchObject({
      label: "민감",
      question: "정치적이거나 사회적으로 논쟁을 부를 수 있는 주장이나 의견",
      timeline_visibility: "hidden",
      search_visibility: "owner",
      public_hide_threshold: 0.5,
    });
    expect(TOPIC_SEED.topics.filter(({ id }) => id !== "sensitive")
      .every((topic) => topic.public_hide_threshold === undefined)).toBe(true);
    const seedSql = buildSql([], [], TOPIC_SEED);
    expect(seedSql).toContain("public_hide_threshold");
    expect(seedSql).toContain("'hidden', 'owner', 0.5");
  });
});
