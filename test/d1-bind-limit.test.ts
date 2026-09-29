import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import type { D1Database, D1PreparedStatement, Env } from "../src/worker/env.js";
import { scorePendingTweets } from "../src/worker/score-queue.js";
import { queryIdChunks } from "../src/worker/db/chunked.js";

interface BindRecord {
  query: string;
  count: number;
  values: unknown[];
}

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0002_visibility_tags.sql", import.meta.url), "utf8"));
  const binds: BindRecord[] = [];
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...input: unknown[]) {
          binds.push({ query, count: input.length, values: input });
          if (input.length > 100) throw new Error(`D1 received ${input.length} bind variables.`);
          values = input;
          return statement;
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all(...values as []) as T[], success: true, meta: { changes: 0 } };
        },
        async first<T>() {
          return sqlite.prepare(query).get(...values as []) as T | null;
        },
        async run<T>() {
          const info = sqlite.prepare(query).run(...values as []);
          return { results: [] as T[], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { db, sqlite, binds };
}

function insertTweets(sqlite: DatabaseSync, count: number) {
  const insert = sqlite.prepare(`
    INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
    VALUES (?, ?, ?, 2024, 1, 'original', ?, 'archive')
  `);
  for (let index = 1; index <= count; index++) {
    const id = `tweet-${String(index).padStart(4, "0")}`;
    const createdAt = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
    insert.run(id, createdAt, "2024-01-01", `Synthetic tweet ${index}`);
  }
}

const baseEnv = (DB: D1Database) => ({
  DB,
  DEV_OWNER: "1",
  SITE_TITLE: "test",
  SEARCH_DAILY_LIMIT: "200",
  TYPESAFE_BASE_URL: "https://jev.test",
  TYPESAFE_API_KEY: "fake",
  ACCOUNT_HANDLE: "test",
  OWNER_EMAILS: "",
  OWNER_SERVICE_TOKEN_IDS: "",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  SCORE_BATCH: "400",
  X_USER_ID: "test",
  JEV_MONTHLY_USD_CAP: "5",
}) as unknown as Env;

describe("D1 bind variable limit", () => {
  it("queries 250 ids in 90, 90, 70 chunks and combines results in order", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const chunkLengths: number[] = [];

    const rows = await queryIdChunks(ids, async (chunk) => {
      chunkLengths.push(chunk.length);
      return chunk.map((id) => `row-${id}`);
    });

    expect(chunkLengths).toEqual([90, 90, 70]);
    expect(rows).toEqual(ids.map((id) => `row-${id}`));
  });

  it("reduces id chunks by the query's reserved bind variables", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const chunkLengths: number[] = [];

    await queryIdChunks(ids, async (chunk) => {
      chunkLengths.push(chunk.length);
      return chunk;
    }, 15);

    expect(chunkLengths).toEqual([85, 85, 80]);
    expect(chunkLengths.every((count) => count + 15 <= 100)).toBe(true);
  });

  it("serves 200 tweets from a 250-tweet result without over-binding", async () => {
    const { db, sqlite, binds } = database();
    insertTweets(sqlite, 250);

    const response = await app.fetch(new Request("https://archive.test/api/tweets?limit=200"), baseEnv(db));
    const body = await response.json() as { tweets: Array<{ id: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.total).toBe(250);
    expect(body.tweets).toHaveLength(200);
    expect(body.tweets.map(({ id }) => id)).toEqual(
      Array.from({ length: 200 }, (_, index) => `tweet-${String(index + 1).padStart(4, "0")}`),
    );
    expect(binds.every(({ count }) => count <= 100)).toBe(true);
  });

  it("scores all 250 queued tweets with SCORE_BATCH 400 and bounded D1 binds", async () => {
    const { db, sqlite, binds } = database();
    sqlite.prepare(`
      INSERT INTO topics (id, label, question, version, sort_order, active)
      VALUES ('games', 'Games', 'video games', 'v1', 1, 1)
    `).run();
    insertTweets(sqlite, 250);
    const jevFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: 0.9 }]));
      return Response.json({ answers, usage: { input_tokens: 100 } });
    });
    vi.stubGlobal("fetch", jevFetch);

    try {
      const result = await scorePendingTweets(baseEnv(db));

      expect(result).toEqual({ scored: 250, stoppedForBudget: false });
      expect(jevFetch).toHaveBeenCalledTimes(250);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scores").get()).toEqual({ count: 250 });
      expect(binds.some(({ query, values }) => query.includes("ORDER BY t.created_at DESC")
        && query.includes("LIMIT ?") && values.length === 1 && values[0] === 400)).toBe(true);
      expect(binds.every(({ count }) => count <= 100)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
