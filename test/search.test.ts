import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import type { JevAnswer } from "../src/shared/jev-client.js";
import type { D1Database, D1PreparedStatement, Env } from "../src/worker/env.js";
import { buildJudgeRequest, chooseStrategies, deriveJudgment } from "../src/worker/search/judge.js";
import { findCandidates } from "../src/worker/search/candidates.js";
import { buildRankRequest } from "../src/worker/search/rank.js";
import { baseTestEnv } from "./d1-test-db.js";

const jevCalls = vi.hoisted(() => ({
  responses: [] as Array<{ answers: Record<string, JevAnswer>; inputTokens: number }>,
  requests: [] as Array<{ questions: Record<string, { instructions: string; criteria?: Record<string, string> }> }>,
}));
vi.mock("../src/shared/jev-client.js", () => ({
  callJev: vi.fn(async (_config, request) => {
    jevCalls.requests.push(request);
    const response = jevCalls.responses.shift();
    if (!response) throw new Error("No fake Jev response was queued.");
    return response;
  }),
}));

const owner = { owner: true, viewingAs: "owner" as const };
const visitor = { owner: false, viewingAs: "visitor" as const };

afterEach(() => {
  jevCalls.responses.length = 0;
  vi.unstubAllGlobals();
});

const topics = [
  { id: "film", label: "영화와 드라마", question: "실사 영화", version: "v5", sort_order: 1, active: 1, timeline_visibility: "public" as const, search_visibility: "public" as const, public_hide_threshold: null },
  { id: "politics", label: "정치", question: "정치와 선거", version: "v5", sort_order: 2, active: 1, timeline_visibility: "public" as const, search_visibility: "owner" as const, public_hide_threshold: null },
  { id: "secret", label: "비공개", question: "비공개", version: "v5", sort_order: 3, active: 1, timeline_visibility: "hidden" as const, search_visibility: "hidden" as const, public_hide_threshold: null },
];

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((entry) => entry.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async all<T>() { return { results: sqlite.prepare(query).all(...values as []) as T[], success: true, meta: { changes: 0 } }; },
        async first<T>() { return sqlite.prepare(query).get(...values as []) as T | null; },
        async run<T>() {
          const info = sqlite.prepare(query).run(...values as []);
          return { results: [] as T[], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return statement;
    },
  };
  for (const topic of topics) {
    sqlite.prepare("INSERT INTO topics (id, label, question, version, sort_order, active, timeline_visibility, search_visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(topic.id, topic.label, topic.question, topic.version, topic.sort_order, topic.active, topic.timeline_visibility, topic.search_visibility);
  }
  return { db, sqlite };
}

function tweet(sqlite: DatabaseSync, id: string, text: string, year = 2015) {
  sqlite.prepare("INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source) VALUES (?, ?, ?, ?, 1, 'original', ?, 'archive')")
    .run(id, `${year}-01-01T00:00:00.000Z`, `${year}-01-01`, year, text);
}

function score(sqlite: DatabaseSync, id: string, topic: string, value: number) {
  sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES (?, ?, ?, 'v5')").run(id, topic, value);
}

describe("visitor search policy", () => {
  it("rejects both visitor search endpoints before parsing or DB access when off", async () => {
    const { db } = database();
    const env = baseTestEnv(db, { VISITOR_SEARCH: "off", DEV_OWNER: "" });
    const prepare = vi.spyOn(db, "prepare");
    for (const request of [
      new Request("https://archive.test/api/search", { method: "POST", body: "invalid JSON" }),
      new Request("https://archive.test/api/search/presets"),
    ]) {
      const response = await app.fetch(request, env);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "search_disabled" });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("applies off to owner visitor preview but leaves owner searches available", async () => {
    const { db, sqlite } = database();
    const env = baseTestEnv(db, { VISITOR_SEARCH: "off" });
    tweet(sqlite, "synthetic-1", "영화 이야기"); score(sqlite, "synthetic-1", "film", 0.9);
    for (const path of ["/api/search", "/api/search/presets"]) {
      const response = await app.request(`${path}?as=visitor`, path.endsWith("presets") ? {} : { method: "POST" }, env);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "search_disabled" });
    }
    expect((await app.request("/api/search/presets", {}, env)).status).toBe(200);
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, topic_secret: { noul: 0.1 },
        period: { probabilities: { "2015": 0.1, none: 0.9 } }, intent: { choice: "many" },
        strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.8 }, strategy_words: { noul: 0.2 } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.9 } }, inputTokens: 100 },
    );
    const response = await app.request("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "영화" }),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ tweet: { id: "synthetic-1" } }] });
  });

  it.each(["presets", "off"] as const)("exposes %s in metadata", async (policy) => {
    const { db } = database();
    const response = await app.request("/api/meta", {}, baseTestEnv(db, { VISITOR_SEARCH: policy }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ visitor_search: policy });
  });
});

describe("search judgment", () => {
  it("asks topic, period, intent and fixed strategy questions in one request", () => {
    const request = buildJudgeRequest("몇 년 전 본 영화", topics.slice(0, 1), [2015, 2016]);
    expect(request.state).toBe("찾는 트윗: 몇 년 전 본 영화");
    expect(request.questions.topic_film).toEqual({
      type: "noul", instructions: "이 질의가 찾는 트윗은 실사 영화에 관한 이야기인가?",
      criteria: { true: "그렇다", false: "아니다" },
    });
    expect(request.questions.period).toEqual({
      type: "choice", instructions: "이 질의가 가리키는 시기는?",
      criteria: { "2015": "2015년", "2016": "2016년", none: "특정한 시기를 가리키지 않는다" },
    });
    expect(request.questions.intent).toEqual({
      type: "choice", instructions: "이 질의가 원하는 것은?",
      criteria: { one: "기억하는 특정한 트윗 하나", many: "조건에 맞는 여러 트윗" },
    });
    expect(Object.keys(request.questions).sort()).toEqual([
      "intent", "period", "strategy_period", "strategy_topics", "strategy_words", "topic_film",
    ]);
  });

  it("uses none at 0.5 and otherwise accumulates years to 0.8", () => {
    const noPeriod = deriveJudgment({
      topic_film: { noul: 0.6 },
      period: { probabilities: { "2015": 0.3, "2016": 0.2, none: 0.5 } },
      intent: { choice: "one" },
      strategy_period: { noul: 0.9 }, strategy_topics: { noul: 0.7 }, strategy_words: { noul: 0.3 },
    }, topics.slice(0, 1), [2015, 2016]);
    expect(noPeriod).toMatchObject({ topics: [{ id: "film", score: 0.6 }], period: null, intent: "one" });
    expect(noPeriod.strategies.map(({ id }) => id)).toEqual(["topics", "words"]);
    const period = deriveJudgment({
      topic_film: { noul: 0.49 },
      period: { probabilities: { "2015": 0.45, "2016": 0.36, "2017": 0.15, none: 0.04 } },
      intent: { choice: "many" },
      strategy_period: { noul: 0.8 }, strategy_topics: { noul: 0.6 }, strategy_words: { noul: 0.1 },
    }, topics.slice(0, 1), [2015, 2016, 2017]);
    expect(period).toMatchObject({ topics: [], period: { from: "2015-01-01", to: "2016-12-31" }, intent: "many" });
    expect(period.topicCoordinates).toEqual([{ id: "film", score: 0.49 }]);
  });

  it("selects a single clear winner, a score band of at most three, or topics and words by default", () => {
    expect(chooseStrategies({ period: 0.8, topics: 0.6, words: 0.3 }, true).filter((s) => s.selected).map((s) => s.id)).toEqual(["period"]);
    expect(chooseStrategies({ period: 0.7, topics: 0.6, words: 0.5 }, true).filter((s) => s.selected).map((s) => s.id)).toEqual(["period", "topics", "words"]);
    expect(chooseStrategies({ period: 0.2, topics: 0.3, words: 0.1 }, true).filter((s) => s.selected).map((s) => s.id)).toEqual(["topics", "words"]);
    expect(chooseStrategies({ period: 0.99, topics: 0.72, words: 0.68 }, false).map((s) => s.id)).toEqual(["topics", "words"]);
  });
});

describe("public search presets", () => {
  it("lets visitors read the public preset list and owners replace it with stable query IDs", async () => {
    const { db } = database();
    const visitorEnv = {
      DB: db, DEV_OWNER: "", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", OWNER_EMAILS: "", OWNER_SERVICE_TOKEN_IDS: "",
    } as Env;
    const empty = await app.fetch(new Request("https://archive.test/api/search/presets"), visitorEnv);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ presets: [] });

    const query = "몇 년 전 본 영화";
    const body = { presets: [{ label: "영화 기억", query }] };
    const ownerEnv = { DB: db, DEV_OWNER: "1" } as Env;
    const put = (payload: unknown, as = "owner") => app.fetch(new Request(`https://archive.test/api/search/presets?as=${as}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }), ownerEnv);
    const first = await put(body);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { presets: Array<{ id: string; label: string; query: string }> };
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
    const expectedId = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
    expect(firstBody).toEqual({ presets: [{ id: expectedId, label: "영화 기억", query }] });

    const second = await put({ presets: [{ label: "영화 회상", query }] });
    expect(await second.json()).toEqual({ presets: [{ id: expectedId, label: "영화 회상", query }] });
    const visible = await app.fetch(new Request("https://archive.test/api/search/presets?as=visitor"), visitorEnv);
    expect(await visible.json()).toEqual({ presets: [{ id: expectedId, label: "영화 회상", query }] });
  });

  it("restricts preset changes to owners and enforces label, query, and count limits", async () => {
    const { db } = database();
    const visitorEnv = {
      DB: db, DEV_OWNER: "", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", OWNER_EMAILS: "", OWNER_SERVICE_TOKEN_IDS: "",
    } as Env;
    const denied = await app.fetch(new Request("https://archive.test/api/search/presets", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ presets: [{ label: "영화", query: "영화" }] }),
    }), visitorEnv);
    expect(denied.status).toBe(403);

    const ownerEnv = { DB: db, DEV_OWNER: "1" } as Env;
    const invalidLists = [
      [{ label: "", query: "영화" }],
      [{ label: "a".repeat(41), query: "영화" }],
      [{ label: "영화", query: "" }],
      [{ label: "영화", query: "a".repeat(201) }],
      Array.from({ length: 21 }, (_, index) => ({ label: `검색 ${index}`, query: `query ${index}` })),
    ];
    for (const presets of invalidLists) {
      const response = await app.fetch(new Request("https://archive.test/api/search/presets", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ presets }),
      }), ownerEnv);
      expect(response.status).toBe(400);
    }
  });

  it("rejects visitor free queries and unknown preset IDs without reserving search quota", async () => {
    const { db, sqlite } = database();
    const env = {
      DB: db, DEV_OWNER: "", SEARCH_DAILY_LIMIT: "1", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "",
      OWNER_EMAILS: "", OWNER_SERVICE_TOKEN_IDS: "",
    } as Env;
    const previousRequests = jevCalls.requests.length;
    const free = await app.fetch(new Request("https://archive.test/api/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "자유 검색", preset_id: "missing" }),
    }), env);
    expect(free.status).toBe(403);
    expect(await free.json()).toEqual({
      error: "free_query_disabled",
      message: "공개 버전에서는 API 호출 비용 때문에 자유 검색어가 제한됩니다.",
    });
    const unknown = await app.fetch(new Request("https://archive.test/api/search", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset_id: "missing" }),
    }), env);
    expect(unknown.status).toBe(404);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key LIKE 'search_count:%'").get()).toBeUndefined();
    expect(jevCalls.requests).toHaveLength(previousRequests);
  });

  it("uses only the saved query and avoids Jev and quota writes on a cache hit", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 이야기"); score(sqlite, "1", "film", 0.9);
    const id = "0123456789ab";
    const query = "설정한 영화 찾기";
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('data_version', 'v1'), ('public_search_presets', ?)")
      .run(JSON.stringify([{ id, label: "영화", query }]));
    const entries = new Map<string, Response>();
    const cache = {
      match: vi.fn(async (key: Request | string) => entries.get(typeof key === "string" ? key : key.url)?.clone()),
      put: vi.fn(async (key: Request | string, response: Response) => {
        entries.set(typeof key === "string" ? key : key.url, response.clone());
      }),
    };
    vi.stubGlobal("caches", { default: cache });
    const env = {
      DB: db, DEV_OWNER: "", SEARCH_DAILY_LIMIT: "1",
      CF_VERSION_METADATA: { id: "deploy-1" },
      ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", OWNER_EMAILS: "", OWNER_SERVICE_TOKEN_IDS: "",
    } as Env;
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, topic_secret: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } }, intent: { choice: "one" }, strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.8 }, strategy_words: { noul: 0.2 } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.93 } }, inputTokens: 100 },
    );
    const request = () => new Request("https://archive.test/api/search?as=visitor", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset_id: id, topics: ["not-allowed"], kinds: ["invalid"], from: "invalid", to: "also-invalid" }),
    });
    const initialJevCalls = jevCalls.requests.length;
    const first = await app.fetch(request(), env);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { q: string; results: Array<{ tweet: { id: string } }> };
    expect(firstBody.q).toBe(query);
    expect(firstBody.results.map(({ tweet: result }) => result.id)).toEqual(["1"]);
    expect(jevCalls.requests).toHaveLength(initialJevCalls + 2);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key LIKE 'search_count:%'").get()).toEqual({ value: "1" });

    const second = await app.fetch(request(), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(jevCalls.requests).toHaveLength(initialJevCalls + 2);
    expect(sqlite.prepare("SELECT value FROM meta WHERE key LIKE 'search_count:%'").get()).toEqual({ value: "1" });
    expect(cache.match).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const cacheKey = cache.match.mock.calls[0][0] as Request;
    const cacheUrl = new URL(cacheKey.url);
    expect(cacheUrl.pathname).toBe(`/api/search/presets/${id}`);
    expect(cacheUrl.searchParams.get("v")).toBe("v1");
    expect(cacheUrl.searchParams.get("as")).toBe("visitor");
    expect(cacheUrl.searchParams.get("cv")).toBe("deploy-1");
  });
});

describe("SQL candidates", () => {
  it("matches article titles and bodies as lexical candidates", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "article-title", "링크만 있는 트윗");
    tweet(sqlite, "article-body", "링크만 있는 다른 트윗");
    sqlite.prepare("UPDATE tweets SET article_title = ?, article_text = ? WHERE id = ?")
      .run("바람의 방향", "본문에는 없는 표현", "article-title");
    sqlite.prepare("UPDATE tweets SET article_title = ?, article_text = ? WHERE id = ?")
      .run("다른 제목", "본문 고유어", "article-body");

    const titleMatch = await findCandidates(db, owner, { q: "방향", strategies: ["words"], topicCoordinates: [] });
    const bodyMatch = await findCandidates(db, owner, { q: "고유어", strategies: ["words"], topicCoordinates: [] });

    expect(titleMatch.map(({ id }) => id)).toEqual(["article-title"]);
    expect(bodyMatch.map(({ id }) => id)).toEqual(["article-body"]);
  });

  it("removes restricted topics at display threshold and keeps lexical or judged matches", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 한 편"); score(sqlite, "1", "film", 0.8);
    tweet(sqlite, "2", "정치 영화"); score(sqlite, "2", "politics", 0.9);
    tweet(sqlite, "3", "비공개 영화"); score(sqlite, "3", "secret", 0.9);
    tweet(sqlite, "4", "낱말 없는 장면"); score(sqlite, "4", "film", 0.6);
    tweet(sqlite, "5", "낱말 없는 저점"); score(sqlite, "5", "film", 0.4);
    const filters = { q: "영화", strategies: ["topics", "words"] as const, topicCoordinates: [{ id: "film", score: 0.8 }] };
    expect((await findCandidates(db, visitor, filters)).map((row) => row.id)).toEqual(["1", "4", "5"]);
    expect((await findCandidates(db, owner, filters)).map((row) => row.id)).toEqual(["1", "2", "4", "5"]);
  });

  it("applies manual filters and prefers word hits before topic score at the 480 cap", async () => {
    const { db, sqlite } = database();
    for (let number = 1; number <= 481; number++) {
      const id = String(number).padStart(3, "0");
      tweet(sqlite, id, number === 481 ? "마지막 영화" : "다른 내용");
      score(sqlite, id, "film", number === 481 ? 0.51 : 0.99);
    }
    const rows = await findCandidates(db, owner, { q: "영화", strategies: ["topics", "words"], topicCoordinates: [{ id: "film", score: 0.8 }], topics: ["film"], kinds: ["original"], from: "2015-01-01", to: "2015-12-31" });
    expect(rows).toHaveLength(480);
    expect(rows[0].id).toBe("481");
    expect(rows.some((row) => row.id === "001")).toBe(false);
  });

  it("uses a weighted topic dot product, quoted text words, period AND, and excludes ranked IDs", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "다른 말", 2015); score(sqlite, "1", "film", 0.8);
    tweet(sqlite, "2", "다른 말", 2015); score(sqlite, "2", "politics", 0.9);
    tweet(sqlite, "3", "다른 말", 2016); score(sqlite, "3", "film", 0.9);
    tweet(sqlite, "4", "다른 말", 2015);
    sqlite.prepare("UPDATE tweets SET quoted_text = '영화 제목' WHERE id = '4'").run();
    const base = { q: "영화", topicCoordinates: [{ id: "film", score: 0.9 }, { id: "politics", score: 0.3 }], period: { from: "2015-01-01", to: "2015-12-31" } };
    expect((await findCandidates(db, owner, { ...base, strategies: ["period", "topics", "words"] })).map((row) => row.id)).toEqual(["4", "1", "2"]);
    expect((await findCandidates(db, owner, { ...base, strategies: ["topics"], excludeIds: ["1"] })).map((row) => row.id)).toEqual(["3", "2"]);
    expect(await findCandidates(db, owner, { ...base, strategies: ["period"], from: "2016-01-01" })).toEqual([]);
  });
});

describe("search ranking and route", () => {
  it("puts date and available context in each rank question", () => {
    const request = buildRankRequest("그 영화", [{
      id: "1", created_at: "2015-01-01T00:00:00.000Z", date_kst: "2015-01-01", kind: "quote", text: "내 감상",
      parent_id: null, parent_text: "원글 내용", parent_author: null, quoted_id: "2", quoted_text: "인용 내용",
      article_title: null, article_text: null,
    }], 0);
    expect(request.questions.c0).toEqual({
      type: "noul",
      instructions: "다음 트윗이 찾는 트윗인가?\n작성일: 2015-01-01\n원글: 원글 내용\n인용한 글: 인용 내용\n트윗: 내 감상",
      criteria: { true: "그렇다", false: "아니다" },
    });
    expect(buildRankRequest("그 영화", [], 0, "related").state).toBe("찾는 트윗: 그 영화");
    expect(buildRankRequest("그 영화", [{ id: "1", created_at: "", date_kst: "2015-01-01", kind: "original", text: "글", parent_id: null, parent_text: null, parent_author: null, quoted_id: null, quoted_text: null, article_title: null, article_text: null }], 0, "related").questions.c0.instructions).toContain("다음 트윗이 찾는 내용과 관련이 있는가?");
  });

  it("adds article content to rank instructions with the shared 3,000-character limit", () => {
    const request = buildRankRequest("그 영화", [{
      id: "1", created_at: "2015-01-01T00:00:00.000Z", date_kst: "2015-01-01", kind: "original", text: "링크만 있는 트윗",
      parent_id: null, parent_text: null, parent_author: null, quoted_id: null, quoted_text: null,
      article_title: "Synthetic ranked article", article_text: "y".repeat(3_005),
    }], 0);

    expect(request.questions.c0.instructions).toContain("아티클 제목: Synthetic ranked article");
    expect(request.questions.c0.instructions).toContain(`아티클 본문: ${"y".repeat(3_000)}`);
    expect(request.questions.c0.instructions).not.toContain("y".repeat(3_001));
  });

  it("returns the article object from the tweets API", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "article-api", "https://x.com/i/article/example");
    sqlite.prepare("UPDATE tweets SET article_title = ?, article_text = ? WHERE id = ?")
      .run("Synthetic API title", "Synthetic API body.", "article-api");

    const response = await app.request("/api/tweets?limit=10&order=desc", {}, baseTestEnv(db));

    expect(response.status).toBe(200);
    const body = await response.json() as { tweets: Array<{ id: string; article: { title: string; text: string } | null }> };
    expect(body.tweets[0].id).toBe("article-api");
    expect(body.tweets[0].article).toEqual({ title: "Synthetic API title", text: "Synthetic API body." });
  });

  it("returns the response contract and enforces the visitor daily limit", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 이야기"); score(sqlite, "1", "film", 0.9);
    const visitorPresetId = "visitor-film";
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('public_search_presets', ?)")
      .run(JSON.stringify([{ id: visitorPresetId, label: "영화", query: "영화" }]));
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } }, intent: { choice: "one" }, strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.8 }, strategy_words: { noul: 0.2 } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.93 } }, inputTokens: 100 },
    );
    const env = { DB: db, DEV_OWNER: "1", SEARCH_DAILY_LIMIT: "1", SITE_TITLE: "test", TYPESAFE_BASE_URL: "https://jev.test", TYPESAFE_API_KEY: "fake", ACCESS_TEAM_DOMAIN: "" } as Env;
    const request = (as = "visitor") => new Request(`https://archive.test/api/search?as=${as}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(as === "visitor" ? { preset_id: visitorPresetId } : { q: "영화" }),
    });
    const first = await app.fetch(request(), env);
    expect(first.status).toBe(200);
    const body = await first.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["q", "judged", "candidates", "results", "stages", "intent", "strategies", "rank_question", "fallback", "rounds"]);
    expect(body.judged).toEqual({ topics: [{ id: "film", score: 0.9 }], period: null });
    expect(body.candidates).toBe(1);
    expect((body.results as Array<{ score: number; why: string; tweet: { id: string } }>)[0]).toMatchObject({ score: 0.93, why: "주제 좌표, 영화와 드라마", tweet: { id: "1" } });
    expect(body).toMatchObject({ intent: "one", rank_question: "exact", fallback: false, rounds: 1 });
    expect((body.stages as Array<{ name: string }>).map((stage) => stage.name)).toEqual(["judge", "candidates", "rank"]);
    const denied = await app.fetch(request(), env);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: "search_limit" });
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } }, intent: { choice: "one" }, strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.8 }, strategy_words: { noul: 0.2 } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.93 } }, inputTokens: 100 },
    );
    expect((await app.fetch(request("owner"), env)).status).toBe(200);
  });

  it("uses a related fallback for one, and a matches question for many", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 이야기"); score(sqlite, "1", "film", 0.9);
    const env = { DB: db, DEV_OWNER: "1", SEARCH_DAILY_LIMIT: "9", SITE_TITLE: "test", TYPESAFE_BASE_URL: "https://jev.test", TYPESAFE_API_KEY: "fake", ACCESS_TEAM_DOMAIN: "" } as Env;
    const answer = (intent: "one" | "many") => ({ answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, topic_secret: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } }, intent: { choice: intent }, strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.8 }, strategy_words: { noul: 0.2 } }, inputTokens: 100 });
    const request = () => new Request("https://archive.test/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "영화" }) });
    jevCalls.responses.push(answer("one"), { answers: { c0: { noul: 0.3 } }, inputTokens: 100 }, { answers: { c0: { noul: 0.7 } }, inputTokens: 100 });
    const one = await (await app.fetch(request(), env)).json() as Record<string, unknown>;
    expect(one).toMatchObject({ intent: "one", rank_question: "related", fallback: true, rounds: 1 });
    expect((one.results as Array<{ tweet: { id: string } }>).map((item) => item.tweet.id)).toEqual(["1"]);
    expect((one.stages as Array<{ name: string }>).map((stage) => stage.name)).toEqual(["judge", "candidates", "rank", "fallback"]);
    jevCalls.responses.push(answer("many"), { answers: { c0: { noul: 0.7 } }, inputTokens: 100 });
    const many = await (await app.fetch(request(), env)).json() as Record<string, unknown>;
    expect(many).toMatchObject({ intent: "many", rank_question: "matches", fallback: false, rounds: 1 });
    expect(jevCalls.requests.at(-1)?.questions.c0.instructions).toContain("다음 트윗이 찾는 조건에 해당하는가?");
    jevCalls.responses.push(answer("one"), { answers: { c0: { noul: 0.2 } }, inputTokens: 100 }, { answers: { c0: { noul: 0.3 } }, inputTokens: 100 });
    const empty = await (await app.fetch(request(), env)).json() as Record<string, unknown>;
    expect(empty).toMatchObject({ results: [], rank_question: "related", fallback: true, rounds: 2 });
  });

  it("tries unused strategies once after empty results without ranking a tweet twice", async () => {
    const previousRequests = jevCalls.requests.length;
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 이야기"); score(sqlite, "1", "film", 0.9);
    tweet(sqlite, "2", "별도 낱말"); score(sqlite, "2", "politics", 0.9);
    const env = { DB: db, DEV_OWNER: "1", SEARCH_DAILY_LIMIT: "9", SITE_TITLE: "test", TYPESAFE_BASE_URL: "https://jev.test", TYPESAFE_API_KEY: "fake", ACCESS_TEAM_DOMAIN: "" } as Env;
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, topic_secret: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } }, intent: { choice: "many" }, strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.8 }, strategy_words: { noul: 0.2 } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.2 } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.8 } }, inputTokens: 100 },
    );
    const response = await app.fetch(new Request("https://archive.test/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "별도 낱말" }) }), env);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ rounds: 2, intent: "many", rank_question: "matches" });
    expect((body.results as Array<{ tweet: { id: string } }>).map((item) => item.tweet.id)).toEqual(["2"]);
    expect((body.stages as Array<{ name: string }>).map((stage) => stage.name)).toEqual(["judge", "candidates", "rank", "round2"]);
    expect(jevCalls.requests.slice(previousRequests).filter((request) => request.questions.c0)).toHaveLength(2);
  });

  it("does not send a year that contains only automatically hidden tweets to Jev", async () => {
    const { db, sqlite } = database();
    const visitorPresetId = "hidden-year-query";
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('public_search_presets', ?)")
      .run(JSON.stringify([{ id: visitorPresetId, label: "찾을 문구", query: "unmatched query" }]));
    sqlite.prepare(`
      INSERT INTO topics (id, label, question, version, sort_order, active,
        timeline_visibility, search_visibility, public_hide_threshold)
      VALUES ('sensitive', '민감', '논쟁적 주장', 'v5', 4, 1, 'public', 'public', 0.5)
    `).run();
    tweet(sqlite, "visible-2024", "visible post", 2024);
    tweet(sqlite, "hidden-2023", "hidden post", 2023);
    score(sqlite, "hidden-2023", "sensitive", 0.9);
    const env = { DB: db, DEV_OWNER: "1", SEARCH_DAILY_LIMIT: "9", SITE_TITLE: "test", TYPESAFE_BASE_URL: "https://jev.test", TYPESAFE_API_KEY: "fake", ACCESS_TEAM_DOMAIN: "" } as Env;
    jevCalls.responses.push({ answers: {
      topic_film: { noul: 0.1 }, topic_sensitive: { noul: 0.1 },
      period: { probabilities: { "2023": 0.1, "2024": 0.1, none: 0.9 } },
      intent: { choice: "one" }, strategy_period: { noul: 0.1 }, strategy_topics: { noul: 0.1 }, strategy_words: { noul: 0.1 },
    }, inputTokens: 100 });
    const response = await app.fetch(new Request("https://archive.test/api/search?as=visitor", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset_id: visitorPresetId }),
    }), env);

    expect(response.status).toBe(200);
    expect(jevCalls.requests.at(-1)?.questions.period.criteria).toMatchObject({ "2024": "2024년" });
    expect(jevCalls.requests.at(-1)?.questions.period.criteria).not.toHaveProperty("2023");
  });
});
