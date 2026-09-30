import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString } from "./lib/cli.js";
import { buildWranglerConfig, parse, readInstanceConfig, SECRET_NAMES, stringify } from "./lib/setup/config.js";
import { configureAccess, ensureResources, findZone } from "./lib/setup/cloudflare.js";
import { setupNode } from "./lib/setup/node.js";
import { resolveXUserId } from "./lib/setup/account.js";
import { SetupRuntime } from "./lib/setup/runtime.js";

export async function setup(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const flags = parseCliArgs(args, {
    instance: { type: "string" }, local: { type: "boolean" }, "dry-run": { type: "boolean" },
  });
  const instanceName = requiredString(flags.instance, "instance");
  if (!/^[a-zA-Z0-9_-]+$/.test(instanceName)) throw new Error("Instance name may contain only letters, digits, _ and -.");
  const local = Boolean(flags.local);
  const dryRun = Boolean(flags["dry-run"]);
  if (local && dryRun) throw new Error("Choose --local or --dry-run, not both.");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22 or newer is required.");
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const instanceDir = resolve(repoRoot, "instances", instanceName);
  const instance = readInstanceConfig(JSON.parse(await readFile(resolve(instanceDir, "config.json"), "utf8")));
  const template = parse(await readFile(resolve(repoRoot, "wrangler.toml"), "utf8"));
  const runtime = new SetupRuntime(repoRoot, dryRun, env);
  if (instance.target === "node") {
    await setupNode(runtime, instanceName, instance, template.vars as Record<string, string>);
    return;
  }
  if (!local) {
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (!env[key]) throw new Error(key + " is required for API token authentication.");
    }
    await runtime.wrangler(["whoami"]);
  }
  const zone = instance.domain?.path
    ? (local ? instance.domain.hostname : await findZone(runtime, instance.domain.hostname))
    : undefined;
  // Local instances need different D1 identities even before remote creation.
  const localId = createHash("sha256").update(instance.worker_name).digest("hex").slice(0, 32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const databaseId = local ? localId : await ensureResources(runtime, instance);
  const config = buildWranglerConfig(template, instance, databaseId, zone);
  const vars = config.vars as Record<string, string>;
  const configName = "wrangler." + instanceName + ".toml";
  const configPath = resolve(repoRoot, configName);
  const configArgs = ["--config", configName];
  const dataDir = resolve(instanceDir, "data");
  const mode = local ? "--local" : "--remote";
  const archive = instance.archive ? resolve(repoRoot, instance.archive) : undefined;
  const topics = resolve(repoRoot, instance.topics ?? "src/shared/topics.json");
  const writeConfig = async () => {
    if (dryRun) console.log("Plan: write " + configName + " from wrangler.toml (including bindings, routes and vars).");
    else await writeFile(configPath, stringify(config), "utf8");
  };
  if (!dryRun) await mkdir(dataDir, { recursive: true });
  await writeConfig();
  await runtime.wrangler(["d1", "migrations", "apply", "DB", mode, ...configArgs], { mutate: true });
  if (!vars.X_USER_ID) {
    await resolveXUserId(vars, archive, env, dryRun);
    await writeConfig();
  }
  const script = async (name: string, extra: string[]) => {
    await runtime.command(["npx", "tsx", "scripts/" + name + ".ts", "--data-dir", dataDir, ...extra], { mutate: true });
  };
  if (archive) {
    await script("import-archive", ["--archive", archive]);
    if ((instance.fetch_context_max_usd ?? 0) > 0 && env.X_BEARER_TOKEN) {
      await script("fetch-context", ["--max-usd", String(instance.fetch_context_max_usd)]);
    }
    if ((instance.score_max_usd ?? 0) > 0 && env.TYPESAFE_BASE_URL && env.TYPESAFE_API_KEY) {
      await script("score", ["--max-usd", String(instance.score_max_usd), "--topics", topics]);
    }
    await script("load-d1", [mode, "--wrangler-config", configName, "--topics", topics]);
    await script("upload-media", [mode, "--wrangler-config", configName, "--archive", archive]);
  } else {
    // Seed topics only; do not replay an earlier instance's tweets or scores.
    const { buildSql } = await import("./load-d1.js");
    const { readTopicSeed } = await import("./lib/topics.js");
    const sqlPath = resolve(dataDir, "seed-topics.sql");
    if (dryRun) console.log("Plan: write topic seed SQL to " + sqlPath);
    else await writeFile(sqlPath, buildSql([], [], await readTopicSeed(topics)), "utf8");
    await runtime.wrangler(["d1", "execute", "DB", "--file", sqlPath, mode, ...configArgs], { mutate: true });
  }
  if (local) {
    await runtime.wrangler(["d1", "execute", "DB", "--local", "--command",
      "SELECT (SELECT COUNT(*) FROM tweets) AS tweets, (SELECT COUNT(*) FROM media) AS media;", ...configArgs]);
    console.log("Local setup finished.");
    return;
  }
  let hostname = instance.domain?.hostname;
  if (!hostname) {
    const subdomain = await runtime.api<{ subdomain: string }>("/accounts/" + env.CLOUDFLARE_ACCOUNT_ID + "/workers/subdomain");
    if (!subdomain?.subdomain) throw new Error("Configure a workers.dev subdomain in Cloudflare before setup.");
    hostname = instance.worker_name + "." + subdomain.subdomain + ".workers.dev";
  }
  await configureAccess(runtime, instance, hostname, vars);
  if (instance.access) await writeConfig();
  await runtime.wrangler(["deploy", ...configArgs], { mutate: true });
  for (const name of SECRET_NAMES) {
    if (env[name]) await runtime.wrangler(["secret", "put", name, ...configArgs], { mutate: true, input: env[name] });
  }
  const siteUrl = "https://" + hostname + (instance.domain?.path ?? "");
  if (dryRun) {
    console.log("Plan: GET " + siteUrl + "/api/health");
    console.log("Plan: GET " + siteUrl + "/api/meta (print total_tweets)");
  } else {
    const health = await fetch(siteUrl + "/api/health");
    if (!health.ok) throw new Error("Health check failed (HTTP " + health.status + ").");
    const healthBody = await health.json() as { ok?: boolean };
    if (healthBody.ok !== true) throw new Error("Health check returned an invalid response.");
    const meta = await fetch(siteUrl + "/api/meta");
    if (!meta.ok) throw new Error("Metadata check failed (HTTP " + meta.status + ").");
    const body = await meta.json() as { total_tweets: number };
    console.log("Site: " + siteUrl + "; health OK; tweets: " + body.total_tweets);
  }
  if (!archive) console.log("아카이브 없이 시작합니다. 첫 수집은 30분 안에 실행됩니다.");
}

if (isDirectExecution(import.meta.url)) setup(process.argv.slice(2), process.env).catch(reportCliError);
