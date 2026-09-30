import { serve } from "@hono/node-server";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import type { Env, WorkerExecutionContext } from "../worker/env.js";
import { isDirectExecution, parseCliArgs, reportCliError } from "../../scripts/lib/cli.js";
import { mergeVars, readTemplate } from "./config.js";
import { applyMigrations, createD1Database } from "./d1-sqlite.js";
import { readEnvFile } from "./env-file.js";
import { createAssets, createMediaBucket, hasTraversal } from "./files.js";
import { startScheduler } from "./scheduler.js";

export async function startServer(args: string[], processEnv: NodeJS.ProcessEnv) {
  const flags = parseCliArgs(args, { instance: { type: "string" } });
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const instance = flags.instance;
  let runtimeEnv = processEnv;
  let dataDir: string;
  if (typeof instance === "string") {
    if (!/^[a-zA-Z0-9_-]+$/.test(instance)) throw new Error("Invalid instance name.");
    const instanceDir = resolve(repoRoot, "instances", instance);
    runtimeEnv = { ...readEnvFile(await readFile(resolve(instanceDir, ".env"), "utf8")), ...processEnv };
    dataDir = resolve(instanceDir, "runtime");
  } else {
    if (!processEnv.DATA_DIR) throw new Error("DATA_DIR is required when running without --instance.");
    dataDir = resolve(processEnv.DATA_DIR);
  }
  const template = await readTemplate();
  await mkdir(resolve(dataDir, "media"), { recursive: true });
  const sqlite = new DatabaseSync(resolve(dataDir, "archive.sqlite"));
  console.log("SQLite migrations: " + applyMigrations(sqlite).length + " applied.");
  const env = {
    ...mergeVars(template.vars, runtimeEnv),
    DB: createD1Database(sqlite), MEDIA: createMediaBucket(resolve(dataDir, "media")), ASSETS: createAssets(resolve(repoRoot, "web")),
  } as unknown as Env;
  const global = globalThis as unknown as { caches?: unknown };
  if (!global.caches) global.caches = { default: { match: async () => undefined, put: async () => {} } };
  const ctx: WorkerExecutionContext & { props: Record<string, unknown> } = {
    props: {},
    waitUntil(promise) { promise.catch((error: unknown) => console.error("waitUntil failed:", error)); },
    passThroughOnException() {},
  };
  const stopScheduler = startScheduler(template.crons, (event) => worker.scheduled(event, env, ctx));
  const port = Number(runtimeEnv.PORT ?? 8787);
  const server = serve({
    port, hostname: instance ? "127.0.0.1" : "0.0.0.0", overrideGlobalObjects: false,
    fetch(request, bindings) {
      if (hasTraversal(bindings.incoming.url ?? "")) return new Response("Not Found", { status: 404 });
      return worker.fetch(request, env, ctx);
    },
  }, () => console.log("Archive listening on port " + port));
  const close = () => {
    stopScheduler();
    server.close(() => { sqlite.close(); });
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  return { server, close };
}
if (isDirectExecution(import.meta.url)) startServer(process.argv.slice(2), process.env).catch(reportCliError);
