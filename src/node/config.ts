import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";

const NODE_SECRET_NAMES = ["X_BEARER_TOKEN", "TYPESAFE_BASE_URL", "TYPESAFE_API_KEY", "OWNER_PASSWORD"];
export function mergeVars(vars: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const merged = { ...vars };
  // Future vars from wrangler.toml pass through without a Node-specific allowlist.
  for (const name of new Set([...Object.keys(vars), ...NODE_SECRET_NAMES])) {
    if (env[name] !== undefined) merged[name] = env[name]!;
  }
  return merged;
}
export async function readTemplate() {
  const config = parse(await readFile(new URL("../../wrangler.toml", import.meta.url), "utf8"));
  return { vars: config.vars as Record<string, string>, crons: (config.triggers as { crons: string[] }).crons };
}
