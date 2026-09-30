import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../../../src/node/d1-sqlite.js";
import { mergeVars } from "../../../src/node/config.js";
import { serializeEnv } from "../../../src/node/env-file.js";
import { buildSql } from "../../load-d1.js";
import { readTopicSeed } from "../topics.js";
import type { InstanceConfig } from "./config.js";
import { configuredInstanceVars } from "./config.js";
import { resolveXUserId } from "./account.js";
import { SetupRuntime } from "./runtime.js";

export async function setupNode(runtime: SetupRuntime, instanceName: string, instance: InstanceConfig, templateVars: Record<string, string>): Promise<void> {
  const { repoRoot, env, dryRun } = runtime;
  const instanceDir = resolve(repoRoot, "instances", instanceName);
  const dataDir = resolve(instanceDir, "data"), runtimeDir = resolve(instanceDir, "runtime");
  const sqlitePath = resolve(runtimeDir, "archive.sqlite"), mediaDir = resolve(runtimeDir, "media");
  const archive = instance.archive ? resolve(repoRoot, instance.archive) : undefined;
  const topics = resolve(repoRoot, instance.topics ?? "src/shared/topics.json");
  const scoreMaxUsd = instance.score_max_usd ?? 2;
  const vars = mergeVars({ ...templateVars, ...configuredInstanceVars(instance) }, env);
  if (instance.domain?.path) vars.BASE_PATH = instance.domain.path;
  if (dryRun) console.log("Plan: apply SQLite migrations in " + runtimeDir);
  else {
    await mkdir(dataDir, { recursive: true }); await mkdir(mediaDir, { recursive: true });
    const sqlite = new DatabaseSync(sqlitePath);
    try { console.log("SQLite migrations: " + applyMigrations(sqlite).length + " applied."); }
    finally { sqlite.close(); }
  }
  await resolveXUserId(vars, archive, env, dryRun);
  const script = async (name: string, extra: string[]) => runtime.command([
    "npx", "tsx", "scripts/" + name + ".ts", "--data-dir", dataDir, ...extra,
  ], { mutate: true });
  if (archive) {
    await script("import-archive", ["--archive", archive]);
    if ((instance.fetch_context_max_usd ?? 0) > 0 && env.X_BEARER_TOKEN) {
      await script("fetch-context", ["--max-usd", String(instance.fetch_context_max_usd)]);
    }
    if (scoreMaxUsd > 0) {
      await script("score", ["--max-usd", String(scoreMaxUsd), "--topics", topics]);
    }
    await script("load-d1", ["--sqlite", sqlitePath, "--topics", topics]);
    await script("upload-media", ["--sqlite", sqlitePath, "--media-dir", mediaDir, "--archive", archive]);
  } else if (dryRun) console.log("Plan: seed SQLite topics only.");
  else {
    const sqlite = new DatabaseSync(sqlitePath);
    try { sqlite.exec(buildSql([], [], await readTopicSeed(topics))); } finally { sqlite.close(); }
  }
  if (dryRun) console.log("Plan: write instances/" + instanceName + "/.env (mode 600; values hidden).");
  else {
    const envPath = resolve(instanceDir, ".env");
    await writeFile(envPath, serializeEnv(vars), { mode: 0o600 }); await chmod(envPath, 0o600);
    const sqlite = new DatabaseSync(sqlitePath);
    try { console.log("Node setup finished; tweets: " + sqlite.prepare("SELECT COUNT(*) AS n FROM tweets").get()!.n); }
    finally { sqlite.close(); }
  }
  console.log("npm run serve -- --instance " + instanceName);
  console.log("INSTANCE=" + instanceName + " docker compose up -d --build");
}
