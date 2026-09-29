import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, Env } from "../src/worker/env.js";

export interface D1Read {
  query: string;
  values: unknown[];
  rows: number;
}

export function createD1TestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const migrationNames = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }

  const reads: D1Read[] = [];
  const binds: Array<{ query: string; count: number; values: unknown[] }> = [];
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
          const results = sqlite.prepare(query).all(...values as []) as T[];
          reads.push({ query, values: [...values], rows: results.length });
          return { results, success: true, meta: { changes: 0 } };
        },
        async first<T>() {
          const result = sqlite.prepare(query).get(...values as []) as T | null;
          reads.push({ query, values: [...values], rows: result == null ? 0 : 1 });
          return result;
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
  return { db, sqlite, reads, binds };
}

export function insertTestTweets(
  sqlite: DatabaseSync,
  count: number,
  createdAt = "2024-01-01T00:00:00.000Z",
): void {
  const insert = sqlite.prepare(`
    INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
    VALUES (?, ?, ?, 2024, 1, 'original', ?, 'archive')
  `);
  for (let index = 1; index <= count; index += 1) {
    const id = `tweet-${String(index).padStart(4, "0")}`;
    insert.run(id, createdAt, "2024-01-01", `Synthetic tweet ${index}`);
  }
}

export function baseTestEnv(DB: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB,
    MEDIA: { get: async () => null, put: async () => undefined },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
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
    X_BEARER_TOKEN: "test-token",
    JEV_MONTHLY_USD_CAP: "5",
    DEV_OWNER: "1",
    ...overrides,
  };
}
