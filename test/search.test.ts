import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import type { D1Database, D1PreparedStatement, Env } from "../src/worker/env.js";
import { buildJudgeRequest, deriveJudgment } from "../src/worker/search/judge.js";
import { findCandidates } from "../src/worker/search/candidates.js";
import { buildRankRequest } from "../src/worker/search/rank.js";

const jevCalls = vi.hoisted(() => ({ responses: [] as Array<{ answers: Record<string, { noul?: number; probabilities?: Record<string, number> }>; inputTokens: number }> }));
vi.mock("../src/shared/jev-client.js", () => ({
  callJev: vi.fn(async () => {
    const response = jevCalls.responses.shift();
    if (!response) throw new Error("No fake Jev response was queued.");
    return response;
  }),
}));

const owner = { owner: true, viewingAs: "owner" as const };
const visitor = { owner: false, viewingAs: "visitor" as const };
const topics = [
  { id: "film", label: "영화와 드라마", question: "실사 영화", version: "v5", sort_order: 1, active: 1, timeline_visibility: "public" as const, search_visibility: "public" as const },
  { id: "politics", label: "정치", question: "정치와 선거", version: "v5", sort_order: 2, active: 1, timeline_visibility: "public" as const, search_visibility: "owner" as const },
  { id: "secret", label: "비공개", question: "비공개", version: "v5", sort_order: 3, active: 1, timeline_visibility: "hidden" as const, search_visibility: "hidden" as const },
];

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0002_visibility_tags.sql", import.meta.url), "utf8"));
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

describe("search judgment", () => {
  it("asks one positive question per allowed topic and a year choice", () => {
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
  });

  it("uses none at 0.5 and otherwise accumulates years to 0.8", () => {
    const noPeriod = deriveJudgment({
      topic_film: { noul: 0.6 },
      period: { probabilities: { "2015": 0.3, "2016": 0.2, none: 0.5 } },
    }, topics.slice(0, 1), [2015, 2016]);
    expect(noPeriod).toEqual({ topics: [{ id: "film", score: 0.6 }], period: null });
    const period = deriveJudgment({
      topic_film: { noul: 0.49 },
      period: { probabilities: { "2015": 0.45, "2016": 0.36, "2017": 0.15, none: 0.04 } },
    }, topics.slice(0, 1), [2015, 2016, 2017]);
    expect(period).toEqual({ topics: [], period: { from: "2015-01-01", to: "2016-12-31" } });
  });
});

describe("SQL candidates", () => {
  it("removes restricted topics at display threshold and keeps lexical or judged matches", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 한 편"); score(sqlite, "1", "film", 0.8);
    tweet(sqlite, "2", "정치 영화"); score(sqlite, "2", "politics", 0.9);
    tweet(sqlite, "3", "비공개 영화"); score(sqlite, "3", "secret", 0.9);
    tweet(sqlite, "4", "낱말 없는 장면"); score(sqlite, "4", "film", 0.6);
    tweet(sqlite, "5", "낱말 없는 저점"); score(sqlite, "5", "film", 0.4);
    expect((await findCandidates(db, visitor, { q: "영화", judgedTopics: ["film"] })).map((row) => row.id)).toEqual(["1", "4"]);
    expect((await findCandidates(db, owner, { q: "영화", judgedTopics: ["film"] })).map((row) => row.id)).toEqual(["1", "2", "4"]);
  });

  it("applies manual filters and prefers word hits before topic score at the 480 cap", async () => {
    const { db, sqlite } = database();
    for (let number = 1; number <= 481; number++) {
      const id = String(number).padStart(3, "0");
      tweet(sqlite, id, number === 481 ? "마지막 영화" : "다른 내용");
      score(sqlite, id, "film", number === 481 ? 0.51 : 0.99);
    }
    const rows = await findCandidates(db, owner, { q: "영화", judgedTopics: ["film"], topics: ["film"], kinds: ["original"], from: "2015-01-01", to: "2015-12-31" });
    expect(rows).toHaveLength(480);
    expect(rows[0].id).toBe("481");
    expect(rows.some((row) => row.id === "001")).toBe(false);
  });
});

describe("search ranking and route", () => {
  it("puts date and available context in each rank question", () => {
    const request = buildRankRequest("그 영화", [{
      id: "1", created_at: "2015-01-01T00:00:00.000Z", date_kst: "2015-01-01", kind: "quote", text: "내 감상",
      parent_id: null, parent_text: "원글 내용", parent_author: null, quoted_id: "2", quoted_text: "인용 내용",
    }], 0);
    expect(request.questions.c0).toEqual({
      type: "noul",
      instructions: "다음 트윗이 찾는 트윗인가?\n작성일: 2015-01-01\n원글: 원글 내용\n인용한 글: 인용 내용\n트윗: 내 감상",
      criteria: { true: "그렇다", false: "아니다" },
    });
  });

  it("returns the response contract and enforces the visitor daily limit", async () => {
    const { db, sqlite } = database();
    tweet(sqlite, "1", "영화 이야기"); score(sqlite, "1", "film", 0.9);
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.93 } }, inputTokens: 100 },
    );
    const env = { DB: db, DEV_OWNER: "1", SEARCH_DAILY_LIMIT: "1", SITE_TITLE: "test", TYPESAFE_BASE_URL: "https://jev.test", TYPESAFE_API_KEY: "fake", ACCESS_TEAM_DOMAIN: "" } as Env;
    const request = (as = "visitor") => new Request(`https://archive.test/api/search?as=${as}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "영화" }),
    });
    const first = await app.fetch(request(), env);
    expect(first.status).toBe(200);
    const body = await first.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["q", "judged", "candidates", "results", "stages"]);
    expect(body.judged).toEqual({ topics: [{ id: "film", score: 0.9 }], period: null });
    expect(body.candidates).toBe(1);
    expect((body.results as Array<{ score: number; why: string; tweet: { id: string } }>)[0]).toMatchObject({ score: 0.93, why: "영화와 드라마", tweet: { id: "1" } });
    expect((body.stages as Array<{ name: string }>).map((stage) => stage.name)).toEqual(["judge", "candidates", "rank"]);
    const denied = await app.fetch(request(), env);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: "search_limit" });
    jevCalls.responses.push(
      { answers: { topic_film: { noul: 0.9 }, topic_politics: { noul: 0.1 }, period: { probabilities: { "2015": 0.1, none: 0.9 } } }, inputTokens: 100 },
      { answers: { c0: { noul: 0.93 } }, inputTokens: 100 },
    );
    expect((await app.fetch(request("owner"), env)).status).toBe(200);
  });
});
