import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import { findCandidates } from "../src/worker/search/candidates.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

const jevRequests = vi.hoisted(() => [] as Array<{ questions: Record<string, any> }>);
vi.mock("../src/shared/jev-client.js", () => ({
  callJev: vi.fn(async (_config, request) => {
    jevRequests.push(request);
    const answers = "period" in request.questions ? {
      period: { probabilities: { none: 1 } }, intent: { choice: "many" },
      strategy_period: { noul: 0 }, strategy_topics: { noul: 0 }, strategy_words: { noul: 1 },
    } : Object.fromEntries(Object.keys(request.questions).map(id => [id, { noul: 1 }]));
    return { answers, inputTokens: 0 };
  }),
}));

beforeEach(() => {
  jevRequests.length = 0;
  const entries = new Map<string, Response>();
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => entries.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { entries.set(key.url, response.clone()); },
  } });
});
afterEach(() => vi.unstubAllGlobals());

function fixture(visibility?: string) {
  const state = createD1TestDatabase();
  const { sqlite } = state;
  sqlite.exec("INSERT INTO meta VALUES ('other_topic', '1'), ('data_version', 'initial')");
  if (visibility) sqlite.prepare("INSERT INTO meta VALUES ('reply_visibility', ?)").run(visibility);
  const insert = sqlite.prepare(`INSERT INTO tweets
    (id, created_at, date_kst, year, month, kind, text, source) VALUES (?, ?, ?, ?, 6, ?, ?, 'archive')`);
  for (const kind of ["original", "self_reply", "quote", "reply"]) {
    insert.run(kind, "2024-06-15T00:00:00Z", "2024-06-15", 2024, kind, `needle ${kind} https://example.com`);
  }
  insert.run("reply-only", "2023-06-15T00:00:00Z", "2023-06-15", 2023, "reply", "needle reply-only https://example.com");
  sqlite.exec(`INSERT INTO link_previews (url, status, title, fetched_at)
    VALUES ('https://example.com', 'none', NULL, '2024-01-01')`);
  return state;
}

function client(db: ReturnType<typeof fixture>["db"], viewingAs: "owner" | "visitor", preview = false) {
  const env = baseTestEnv(db, { DEV_OWNER: viewingAs === "owner" || preview ? "1" : "" });
  const fetch = (path: string, init?: RequestInit) => app.fetch(new Request(`https://archive.test${path}${preview ? `${path.includes('?') ? '&' : '?'}as=visitor` : ''}`, init), env);
  return { fetch, json: async (path: string) => (await fetch(path)).json() as Promise<any> };
}

describe("reply scope across reading surfaces", () => {
  for (const visibility of [undefined, "hidden", "owner", "public"]) {
    for (const viewingAs of ["owner", "visitor"] as const) {
      it(`${visibility ?? 'missing'} / ${viewingAs}`, async () => {
        const { db, sqlite } = fixture(visibility);
        const { json, fetch } = client(db, viewingAs);
        const included = visibility === "public" || visibility === "owner" && viewingAs === "owner";
        const total = included ? 5 : 3;
        const yearTotal = included ? 4 : 3;
        const list = await json("/api/tweets");
        expect(list.total).toBe(total);
        expect(list.tweets.map((t: any) => t.id).sort()).toEqual(included
          ? ["original", "quote", "reply", "reply-only", "self_reply"] : ["original", "quote", "self_reply"]);
        expect((await json("/api/tweets?kind=reply")).total).toBe(included ? 2 : 0);
        const timeline = await json("/api/timeline");
        expect(timeline.years.map((y: any) => y.year)).toEqual(included ? [2023, 2024] : [2024]);
        expect(timeline.years.find((y: any) => y.year === 2024)).toMatchObject({ total: yearTotal, counts: { other: yearTotal } });
        expect((await json("/api/timeline/2024")).months[5]).toMatchObject({ total: yearTotal, counts: { other: yearTotal } });
        expect((await json("/api/calendar?year=2024&month=6")).days).toEqual([{ date: "2024-06-15", total: yearTotal, top_topic: "other" }]);
        expect((await json("/api/calendar?year=2023&month=6")).days.length).toBe(included ? 1 : 0);
        const today = await json("/api/on-this-day?md=06-15");
        expect(today.years.map((y: any) => y.year)).toEqual(included ? [2024, 2023] : [2024]);
        expect(today.years[0].total).toBe(yearTotal);
        if (!included) expect(today.years.flatMap((y: any) => y.tweets).some((t: any) => t.kind === "reply")).toBe(false);
        const meta = await json("/api/meta");
        expect(meta).toMatchObject({ total_tweets: total, first_date: included ? "2023-06-15" : "2024-06-15", last_date: "2024-06-15" });
        if (viewingAs === "owner") expect(meta.reply_visibility).toBe(visibility ?? "hidden");
        else expect(meta).not.toHaveProperty("reply_visibility");
        expect((await json("/api/tweets?topics=other")).total).toBe(total);
        const viewer = { owner: viewingAs === "owner", viewingAs };
        const candidates = await findCandidates(db, viewer, { q: "needle", strategies: ["words"], topicCoordinates: [] });
        expect(candidates.length).toBe(total);
        expect((await fetch("/api/link-preview?tweet=reply&url=https://example.com")).status).toBe(included ? 200 : 404);
        expect((await fetch("/api/link-preview?tweet=self_reply&url=https://example.com")).status).toBe(200);
        sqlite.prepare("INSERT INTO meta VALUES ('public_search_presets', ?)").run(JSON.stringify([{ id: "needle", label: "needle", query: "needle" }]));
        const search = await fetch("/api/search", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(viewingAs === "owner" ? { q: "needle" } : { preset_id: "needle" }),
        });
        expect(search.status).toBe(200);
        expect((await search.json()).results.length).toBe(total);
        expect(jevRequests[0].questions.period.criteria).toEqual(included
          ? { "2023": "2023년", "2024": "2024년", none: "특정한 시기를 가리키지 않는다" }
          : { "2024": "2024년", none: "특정한 시기를 가리키지 않는다" });
        sqlite.exec(`INSERT INTO topics (id,label,question,version,active,timeline_visibility,search_visibility,sort_order)
          VALUES ('games','게임','게임','current',1,'public','public',1);
          INSERT INTO scores VALUES ('reply','games',0.9,'current'), ('self_reply','games',0.9,'current');
          UPDATE meta SET value = 'scored' WHERE key = 'data_version'`);
        expect((await json("/api/timeline")).years.find((y: any) => y.year === 2024).counts)
          .toEqual({ games: included ? 2 : 1, other: 2 });
        expect((await json("/api/tweets?topics=games")).total).toBe(included ? 2 : 1);
      });
    }
  }

  it("reads one reply setting per request and none on aggregate cache hits", async () => {
    const { db, reads } = fixture("hidden");
    const { json, fetch } = client(db, "owner");
    const settingReads = () => reads.filter(r => r.query.includes("reply_visibility")).length;
    for (const path of ["/api/tweets", "/api/tweets?topics=other", "/api/on-this-day?md=06-15",
      "/api/timeline", "/api/timeline/2024", "/api/calendar?year=2024&month=6", "/api/meta",
      "/api/link-preview?tweet=reply&url=https://example.com"]) {
      const before = settingReads();
      await json(path);
      expect(settingReads() - before).toBe(1);
    }
    for (const path of ["/api/timeline", "/api/timeline/2024", "/api/calendar?year=2024&month=6"]) {
      const before = settingReads();
      await json(path);
      expect(settingReads() - before).toBe(0);
    }
    const before = settingReads();
    await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "needle" }) });
    expect(settingReads() - before).toBe(1);
    const settingRows = reads.filter(r => r.query.includes("WHERE key = 'reply_visibility'"));
    expect(settingRows.every(r => r.rows <= 1)).toBe(true);
  });

  it("uses visitor scope in owner preview", async () => {
    const { db } = fixture("owner");
    const { json } = client(db, "visitor", true);
    expect((await json("/api/tweets")).total).toBe(3);
    expect((await json("/api/meta")).total_tweets).toBe(3);
  });

  it("stores owner settings, rejects invalid inputs and invalidates aggregate caches", async () => {
    const { db, sqlite } = fixture();
    const owner = client(db, "owner"), visitor = client(db, "visitor");
    const put = (visibility: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility }) });
    expect((await owner.json("/api/timeline")).years.length).toBe(1);
    expect((await visitor.fetch("/api/settings/replies", put("public"))).status).toBe(403);
    expect((await owner.fetch("/api/settings/replies", put("invalid"))).status).toBe(400);
    expect((await owner.fetch("/api/settings/replies", put("public"))).status).toBe(200);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'reply_visibility'").get()).toEqual({ value: "public" });
    expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()).not.toEqual({ value: "initial" });
    expect((await owner.json("/api/timeline")).years.length).toBe(2);
    expect((await owner.json("/api/meta")).reply_visibility).toBe("public");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tweets").get()).toEqual({ count: 5 });
  });
});
