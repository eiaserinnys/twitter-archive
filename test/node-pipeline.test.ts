import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { buildSql, loadD1 } from "../scripts/load-d1.js";
import { uploadMedia } from "../scripts/upload-media.js";
import { importArchive } from "../scripts/import-archive.js";
import { readInstanceConfig } from "../scripts/lib/setup/config.js";
import { applyMigrations } from "../src/node/d1-sqlite.js";
import { writeSyntheticArchive } from "./fixtures.js";
import type { NormalizedTweet } from "../src/shared/types.js";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), execFile: vi.fn() }));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); vi.clearAllMocks(); });
it("validates the node target and excludes passwords from config", () => {
  expect(readInstanceConfig({ worker_name: "smoke", target: "node" }).target).toBe("node");
  expect(() => readInstanceConfig({ worker_name: "smoke", target: "postgres" })).toThrow(/target/);
  expect(() => readInstanceConfig({ worker_name: "smoke", vars: { OWNER_PASSWORD: "secret" } })).toThrow(/environment/);
});
it("seeds article links unresolved and preserves article values on archive upsert", () => {
  const row = (id: string, text: string): NormalizedTweet => ({
    id,
    created_at_utc: "2024-01-01T00:00:00.000Z",
    date_kst: "2024-01-01",
    year: 2024,
    month: 1,
    kind: "original",
    text,
    parent: null,
    quoted: null,
    lang: null,
    source: "archive",
    media: [],
  });
  const ordinary = row("901", "A synthetic ordinary post");
  const article = row("902", "https://x.com/i/article/synthetic");
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db);
    const sql = buildSql([ordinary, article], []);
    db.exec(sql);
    expect(db.prepare("SELECT id, article_title FROM tweets ORDER BY id").all()).toEqual([
      { id: "901", article_title: "" },
      { id: "902", article_title: null },
    ]);

    db.exec("UPDATE tweets SET article_title = 'Stored title', article_text = 'Stored body' WHERE id = '901'");
    db.exec(sql);
    expect(db.prepare("SELECT article_title, article_text FROM tweets WHERE id = '901'").get())
      .toEqual({ article_title: "Stored title", article_text: "Stored body" });
  } finally {
    db.close();
  }
});
it("loads sqlite and copies archive media twice without wrangler or duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-node-pipeline-")); directories.push(dir);
  const archive = join(dir, "fixture.zip"), sqlitePath = join(dir, "archive.sqlite"), mediaDir = join(dir, "media");
  await writeSyntheticArchive(archive);
  const db = new DatabaseSync(sqlitePath); applyMigrations(db); db.close();
  for (const expectedUploads of [3, 0]) {
    await importArchive({ archive, dataDir: dir });
    expect((await loadD1({ dataDir: dir, sqlite: sqlitePath })).tweets).toBe(7);
    expect(await uploadMedia({ archive, dataDir: dir, sqlite: sqlitePath, mediaDir })).toBe(expectedUploads);
  }
  const finalDb = new DatabaseSync(sqlitePath);
  try {
    expect(finalDb.prepare("SELECT COUNT(*) AS n FROM tweets").get()).toEqual({ n: 7 });
    const row = finalDb.prepare("SELECT r2_key FROM media WHERE r2_key IS NOT NULL LIMIT 1").get()!;
    expect((await readFile(join(mediaDir, String(row.r2_key)))).length).toBeGreaterThan(0);
  } finally { finalDb.close(); }
  expect(execFile).not.toHaveBeenCalled(); expect(execFileSync).not.toHaveBeenCalled();
});
it("preserves owner settings and existing media keys on repeated archive loads", async () => {
  const { buildSql } = await import("../scripts/load-d1.js");
  const { normalizeArchive } = await import("../src/archive/normalize.js");
  const { syntheticArchiveFiles } = await import("./fixtures.js");
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db);
    const sql = buildSql(normalizeArchive(syntheticArchiveFiles()), []);
    db.exec(sql);
    db.exec("UPDATE tweets SET visibility = 'private' WHERE id = '101'; UPDATE topics SET label = '소유자 라벨', timeline_visibility = 'owner', search_visibility = 'owner', public_hide_threshold = 0.7, active = 0; UPDATE media SET r2_key = 'media/saved.jpg' WHERE tweet_id = '101'");
    db.exec(sql); db.exec(sql);
    expect(db.prepare("SELECT visibility FROM tweets WHERE id = '101'").get()).toEqual({ visibility: "private" });
    expect(db.prepare("SELECT DISTINCT label, timeline_visibility, search_visibility, public_hide_threshold, active FROM topics").all()).toEqual([{ label: "소유자 라벨", timeline_visibility: "owner", search_visibility: "owner", public_hide_threshold: 0.7, active: 0 }]);
    expect(db.prepare("SELECT r2_key FROM media WHERE tweet_id = '101'").get()).toEqual({ r2_key: "media/saved.jpg" });
  } finally { db.close(); }
});
