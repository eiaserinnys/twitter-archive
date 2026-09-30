import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createD1Database, applyMigrations } from "../src/node/d1-sqlite.js";
import { createMediaBucket, createAssets, safePath } from "../src/node/files.js";
import { cronInterval, cronMatches, startScheduler } from "../src/node/scheduler.js";
import { mergeVars } from "../src/node/config.js";

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "archive-node-"));
  directories.push(dir);
  return dir;
}
it("adapts bound reads, first columns, changes and atomic batches", async () => {
  const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
  sqlite.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT)");
  const db = createD1Database(sqlite);
  expect((await db.prepare("INSERT INTO items VALUES (?, ?)").bind(1, "한글").run()).meta.changes).toBe(1);
  expect((await db.prepare("SELECT * FROM items WHERE id = ?").bind(1).all()).results).toEqual([{ id: 1, text: "한글" }]);
  expect(await db.prepare("SELECT * FROM items").first("text")).toBe("한글");
  expect(await db.prepare("SELECT * FROM items WHERE id = 2").first()).toBeNull();
  expect(await db.batch!([db.prepare("SELECT text FROM items"), db.prepare("INSERT INTO items VALUES (2, 'two')")])).toMatchObject([{ results: [{ text: "한글" }] }, { meta: { changes: 1 } }]);
  await expect(db.batch!([db.prepare("INSERT INTO items VALUES (3, 'three')"), db.prepare("INSERT INTO items VALUES (1, 'duplicate')")])).rejects.toThrow();
  expect(await db.prepare("SELECT * FROM items WHERE id = 3").first()).toBeNull();
});
it("applies each migration once and records its name", async () => {
  const dir = await directory();
  const sqlite = new DatabaseSync(join(dir, "archive.sqlite")); databases.push(sqlite);
  const migrations = join(dir, "migrations"); await mkdir(migrations);
  await writeFile(join(migrations, "0001.sql"), "CREATE TABLE once_only (id INTEGER)");
  expect(applyMigrations(sqlite, migrations)).toEqual(["0001.sql"]);
  expect(applyMigrations(sqlite, migrations)).toEqual([]);
  expect(sqlite.prepare("SELECT name FROM d1_migrations").all()).toEqual([{ name: "0001.sql" }]);
});
it("streams media, writes files and blocks escaped keys", async () => {
  const dir = await directory(); const media = createMediaBucket(join(dir, "media"));
  await media.put("media/1/photo.png", new Uint8Array([1, 2, 3]));
  const object = await media.get("media/1/photo.png");
  expect(Array.from(new Uint8Array(await new Response(object!.body).arrayBuffer()))).toEqual([1, 2, 3]);
  const headers = new Headers(); object!.writeHttpMetadata(headers);
  expect(headers.get("Content-Type")).toBe("image/png");
  expect(await media.get("../../outside.png")).toBeNull();
  expect(await media.get("/outside.png")).toBeNull();
  await expect(media.put("../outside.png", "bad")).rejects.toThrow();
  expect(safePath(dir, "../outside")).toBeNull();
});
it("serves assets and SPA fallback while refusing traversal", async () => {
  const dir = await directory(); await writeFile(join(dir, "index.html"), "<h1>SPA</h1>");
  await writeFile(join(dir, "app.js"), "console.log('asset')");
  const assets = createAssets(dir);
  expect(await (await assets.fetch(new Request("https://local/app.js"))).text()).toContain("asset");
  expect(await (await assets.fetch(new Request("https://local/deep/route"))).text()).toContain("SPA");
  expect((await assets.fetch(new Request("https://local/%2e%2e%2foutside"))).status).toBe(404);
});
it("merges template vars with process overrides and new names", () => {
  expect(mergeVars({ SITE_TITLE: "default", OWNER_AUTH: "password" }, { SITE_TITLE: "override", OWNER_PASSWORD: "test", X_BEARER_TOKEN: "test", PATH: "ignored" }))
    .toEqual({ SITE_TITLE: "override", OWNER_AUTH: "password", OWNER_PASSWORD: "test", X_BEARER_TOKEN: "test" });
});
it("accepts only supported minute crons and matches wall clock minutes", () => {
  expect(cronInterval("* * * * *")).toBe(1);
  expect(cronInterval("*/30 * * * *")).toBe(30);
  expect(cronMatches(30, Date.UTC(2026, 0, 1, 0, 30))).toBe(true);
  expect(cronMatches(30, Date.UTC(2026, 0, 1, 0, 31))).toBe(false);
  for (const cron of ["0 * * * *", "*/0 * * * *", "* 1 * * *", "*/3 * * * 1"]) expect(() => cronInterval(cron)).toThrow();
});
it("aligns to the minute and skips an overlapping execution of the same cron", async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 20));
  let finish!: () => void;
  const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const stop = startScheduler(["* * * * *"], run);
  await vi.advanceTimersByTimeAsync(39_999); expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledWith({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 0, 1, 0, 1) });
  await vi.advanceTimersByTimeAsync(60_000); expect(run).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(60_000); expect(run).toHaveBeenCalledTimes(2);
  finish(); stop();
});
it("roundtrips instance env quoting without expanding dollar signs", async () => {
  const { serializeEnv, readEnvFile } = await import("../src/node/env-file.js");
  const values = { SITE_TITLE: "한글", OWNER_PASSWORD: "a'\"$VALUE\\text\nnext", EMPTY: "" };
  expect(readEnvFile(serializeEnv(values))).toEqual(values);
});
