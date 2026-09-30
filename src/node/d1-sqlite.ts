import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../worker/env.js";

export function createD1Database(sqlite: DatabaseSync): D1Database {
  const executors = new WeakMap<D1PreparedStatement, () => D1Result<Record<string, unknown>>>();
  return {
    prepare(query) {
      const compiled = sqlite.prepare(query);
      let values: SQLInputValue[] = [];
      const execute = () => {
        const results = compiled.all(...values);
        const changes = compiled.columns().length === 0
          ? Number(sqlite.prepare("SELECT changes() AS n").get()!.n) : 0;
        return { results, success: true, meta: { changes } };
      };
      const statement: D1PreparedStatement = {
        bind(...input) { values = input as SQLInputValue[]; return statement; },
        async all<T>() { return execute() as D1Result<T>; },
        async first<T>(column?: string) {
          const row = compiled.get(...values);
          return (row === undefined ? null : column === undefined ? row : row[column] ?? null) as T | null;
        },
        async run<T>() {
          const info = compiled.run(...values);
          return { results: [] as T[], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      executors.set(statement, execute);
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        // Execute synchronously throughout the transaction; no request can interleave.
        const results = statements.map((statement) => executors.get(statement)!());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}

export function applyMigrations(
  sqlite: DatabaseSync,
  directory = fileURLToPath(new URL("../../migrations/", import.meta.url)),
): string[] {
  sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(sqlite.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name));
  const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const added: string[] = [];
  for (const name of names) {
    if (applied.has(name)) continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(join(directory, name), "utf8"));
      sqlite.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      sqlite.exec("COMMIT"); added.push(name);
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  return added;
}
