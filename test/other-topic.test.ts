import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

beforeEach(() => {
  const entries = new Map<string, Response>();
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => entries.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { entries.set(key.url, response.clone()); },
  } });
});
afterEach(() => vi.unstubAllGlobals());

function fixture(enabled = true) {
  const data = createD1TestDatabase();
  const { sqlite } = data;
  sqlite.exec(`
    INSERT INTO meta (key, value) VALUES ('data_version', 'initial');
    INSERT INTO topics (id, label, question, version, sort_order, active,
      timeline_visibility, search_visibility, public_hide_threshold) VALUES
    ('games', '게임', '게임', 'current', 1, 1, 'public', 'public', NULL),
    ('hidden', '숨긴 주제', '숨긴 주제', 'current', 2, 1, 'hidden', 'hidden', NULL),
    ('sensitive', '민감', '민감', 'current', 3, 1, 'hidden', 'hidden', 0.5),
    ('deleted', '삭제', '삭제', 'current', 4, 0, 'public', 'public', NULL);
  `);
  if (enabled) sqlite.exec("INSERT INTO meta (key, value) VALUES ('other_topic', '1')");
  const tweet = sqlite.prepare(`
    INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source, visibility)
    VALUES (?, ?, ?, 2024, ?, 'original', ?, 'archive', ?)
  `);
  const ids = ["unscored", "below", "games", "hidden", "private", "sensitive", "deleted", "old", "public-override"];
  ids.forEach((id, index) => tweet.run(id, `2024-06-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    `2024-06-${String(index + 1).padStart(2, "0")}`, 6, `Synthetic ${id}`,
    id === "private" ? "private" : id === "public-override" ? "public" : null));
  tweet.run("july", "2024-07-01T00:00:00Z", "2024-07-01", 7, "Synthetic July", null);
  const score = sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES (?, ?, ?, ?)");
  score.run("below", "games", 0.69, "current");
  score.run("games", "games", 0.7, "current");
  score.run("hidden", "hidden", 0.9, "current");
  score.run("sensitive", "sensitive", 0.6, "old");
  score.run("deleted", "deleted", 0.9, "current");
  score.run("old", "games", 0.9, "old");
  score.run("public-override", "sensitive", 0.6, "current");
  return { ...data, env: baseTestEnv(data.db) };
}

function request(env: ReturnType<typeof baseTestEnv>, path: string, init?: RequestInit) {
  return app.fetch(new Request(`https://archive.test${path}`, init), env);
}
async function json(env: ReturnType<typeof baseTestEnv>, path: string) {
  const response = await request(env, path);
  expect(response.status).toBe(200);
  return response.json();
}
const toggle = (env: ReturnType<typeof baseTestEnv>, enabled: unknown) =>
  request(env, "/api/topics/other", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }) });
const otherIds = ["unscored", "below", "deleted", "old", "public-override", "july"];

describe("builtin other classification", () => {
  it.each(["owner", "visitor"])("uses all active current topics and excludes public hidden tweets for %s", async viewer => {
    const { env } = fixture();
    const suffix = viewer === "visitor" ? "&as=visitor" : "";
    const result = await json(env, `/api/tweets?topics=other${suffix}`);
    expect(result.tweets.map((tweet: { id: string }) => tweet.id)).toEqual(otherIds);
    expect(result.total).toBe(6);
    expect(result.tweets.every((tweet: { topics: Array<{ id: string }> }) =>
      tweet.topics.every(topic => topic.id !== "other"))).toBe(true);
    const union = await json(env, `/api/tweets?topics=games,other${suffix}`);
    expect(union.total).toBe(7);
    const timeline = await json(env, `/api/timeline?${suffix.slice(1)}`);
    expect(timeline.years[0].counts.other).toBe(result.total);
    const months = await json(env, `/api/timeline/2024?${suffix.slice(1)}`);
    expect(months.months[5].counts.other).toBe(5);
    expect(months.months[6].counts.other).toBe(1);
    const june = await json(env, `/api/tweets?topics=other&year=2024&month=6${suffix}`);
    expect(june.total).toBe(months.months[5].counts.other);
  });

  it("appends a virtual meta topic without a topic row or counts", async () => {
    const { env, sqlite } = fixture();
    for (const suffix of ["", "?as=visitor"]) {
      const meta = await json(env, `/api/meta${suffix}`);
      expect(meta.topics.at(-1)).toMatchObject({ id: "other", label: "기타", question: "", builtin: true,
        timeline_visibility: "public", search_visibility: "hidden", public_hide_threshold: null });
      expect(meta.topics.at(-1).sort_order).toBeGreaterThan(4);
      expect(meta.topics.at(-1)).not.toHaveProperty("scored");
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM topics WHERE id = 'other'").get()).toEqual({ n: 0 });
  });

  it("keeps disabled meta and timeline unchanged and rejects the unknown filter", async () => {
    const { env, sqlite } = fixture(false);
    sqlite.exec("INSERT INTO meta (key, value) VALUES ('other_topic', 'true')");
    const meta = await json(env, "/api/meta");
    expect(meta.topics.some((topic: { id: string }) => topic.id === "other")).toBe(false);
    const years = await json(env, "/api/timeline");
    expect(years.years[0].counts).not.toHaveProperty("other");
    expect((await request(env, "/api/tweets?topics=other")).status).toBe(400);
  });

  it.each(["owner", "visitor"])("uses other only as the calendar fallback for %s", async viewer => {
    const { env, sqlite } = fixture();
    // A day with visible topic tweets must keep that topic even with more other tweets.
    sqlite.exec("UPDATE tweets SET date_kst = '2024-06-01' WHERE id IN ('games', 'below')");
    const calendar = await json(env, `/api/calendar?year=2024&month=6${viewer === "visitor" ? "&as=visitor" : ""}`);
    const byDate = new Map(calendar.days.map((day: { date: string; top_topic: string }) => [day.date, day.top_topic]));
    expect(byDate.get("2024-06-01")).toBe("games");
    expect(byDate.get("2024-06-04")).toBeNull();
    expect(byDate.get("2024-06-07")).toBe("other");
    expect(byDate.get("2024-06-08")).toBe("other");
    if (viewer === "owner") expect(byDate.get("2024-06-05")).toBeNull();
    else expect(byDate.has("2024-06-05")).toBe(false);
  });

  it("toggles only for the owner, validates booleans, and invalidates aggregate caches", async () => {
    const { env, db, sqlite } = fixture(false);
    expect((await toggle(baseTestEnv(db, { DEV_OWNER: "0" }), true)).status).toBe(403);
    expect((await toggle(env, "1")).status).toBe(400);
    await json(env, "/api/meta");
    await json(env, "/api/timeline");
    await json(env, "/api/calendar?year=2024&month=6");
    expect((await toggle(env, true)).status).toBe(200);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).not.toEqual({ value: "initial" });
    expect((await json(env, "/api/meta")).topics.at(-1).id).toBe("other");
    expect((await json(env, "/api/timeline")).years[0].counts.other).toBe(6);
    expect((await json(env, "/api/calendar?year=2024&month=6")).days[0].top_topic).toBe("other");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1);
    expect((await toggle(env, false)).status).toBe(200);
    expect((await json(env, "/api/meta")).topics.some((topic: { id: string }) => topic.id === "other")).toBe(false);
    expect((await json(env, "/api/timeline")).years[0].counts).not.toHaveProperty("other");
    vi.restoreAllMocks();
  });

  it("does not read builtin state or aggregate tweets on cache hits, and separates calendar months and viewers", async () => {
    const { env, reads } = fixture();
    for (const path of ["/api/meta", "/api/timeline", "/api/timeline/2024", "/api/calendar?year=2024&month=6"]) {
      await json(env, path);
      reads.length = 0;
      await json(env, path);
      expect(reads.some(read => /other_topic|FROM tweets/i.test(read.query))).toBe(false);
    }
    const july = await json(env, "/api/calendar?year=2024&month=7");
    expect(july.days).toEqual([{ date: "2024-07-01", total: 1, top_topic: "other" }]);
    const visitor = await json(env, "/api/calendar?year=2024&month=6&as=visitor");
    expect(visitor.days.some((day: { date: string }) => day.date === "2024-06-05")).toBe(false);
  });

  it("executes no other aggregate query when disabled", async () => {
    const { env, reads } = fixture(false);
    await json(env, "/api/timeline");
    await json(env, "/api/timeline/2024");
    await json(env, "/api/calendar?year=2024&month=6");
    expect(reads.some(read => /assigned|AS other_count/i.test(read.query))).toBe(false);
  });

  it("makes A and B return the same synthetic tweet set", async () => {
    const { sqlite } = fixture();
    const { otherTweetSql, assignedTweetIdsSql } = await import("../src/worker/other-topic.js");
    const query = (membership?: string) => `SELECT t.id FROM tweets t WHERE ${otherTweetSql("t", membership)} ORDER BY t.created_at, t.id`;
    const a = sqlite.prepare(`WITH assigned AS MATERIALIZED (${assignedTweetIdsSql()}) ${query("assigned")}`).all();
    const b = sqlite.prepare(query()).all();
    expect(a).toEqual(b);
    expect(a.map(row => row.id)).toEqual(otherIds);
  });
});

describe("tweet pagination count", () => {
  it.each([undefined, "other"])("counts only the first page for topics=%s", async topics => {
    const { env, reads } = fixture();
    const path = `/api/tweets?limit=2${topics ? `&topics=${topics}` : ""}`;
    const first = await json(env, path);
    expect(first.total).toBe(topics ? 6 : 10);
    expect(first.next_cursor).toBeTypeOf("string");
    reads.length = 0;
    const next = await json(env, `${path}&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(next.total).toBeNull();
    expect(next.tweets).toHaveLength(2);
    expect(reads.some(read => /SELECT COUNT\(\*\) AS total FROM tweets/i.test(read.query))).toBe(false);
  });
});
