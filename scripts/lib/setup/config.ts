import { parse, stringify, type TomlTable } from "smol-toml";

export const SECRET_NAMES = ["X_BEARER_TOKEN", "TYPESAFE_BASE_URL", "TYPESAFE_API_KEY", "OWNER_PASSWORD"] as const;

export interface InstanceConfig {
  worker_name: string;
  target?: "cloudflare" | "node";
  d1_name?: string;
  r2_bucket?: string;
  domain?: { hostname: string; path?: string };
  vars?: Record<string, string>;
  archive?: string;
  topics?: string;
  fetch_context_max_usd?: number;
  score_max_usd?: number;
  access?: { policy_ids: string[] };
}

export function readInstanceConfig(value: unknown): InstanceConfig {
  if (!value || typeof value !== "object" || !("worker_name" in value) ||
      typeof value.worker_name !== "string" || !value.worker_name.trim()) {
    throw new Error("config.json requires worker_name.");
  }
  const config = value as InstanceConfig;
  if (config.target !== undefined && config.target !== "cloudflare" && config.target !== "node") {
    throw new Error("target must be cloudflare or node.");
  }
  if (config.score_max_usd === undefined) config.score_max_usd = 2;
  if (config.vars && Object.keys(config.vars).some((name) =>
    [...SECRET_NAMES, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].includes(name as typeof SECRET_NAMES[number]))) {
    throw new Error("Supply credentials through environment variables, never config.json vars.");
  }
  if (config.domain?.path && (!config.domain.path.startsWith("/") || config.domain.path.endsWith("/"))) {
    throw new Error("domain.path must start with / and have no trailing / (use an empty path for a full hostname).");
  }
  for (const key of ["fetch_context_max_usd", "score_max_usd"] as const) {
    if (config[key] !== undefined && (typeof config[key] !== "number" || !Number.isFinite(config[key]) || config[key]! < 0)) {
      throw new Error(key + " must be a non-negative number.");
    }
  }
  return config;
}

export function buildWranglerConfig(
  template: TomlTable,
  instance: InstanceConfig,
  databaseId: string,
  zoneName?: string,
): TomlTable {
  const config = structuredClone(template);
  config.name = instance.worker_name;
  config.vars = { ...config.vars as TomlTable, ...instance.vars };
  delete config.route;
  delete config.routes;
  config.workers_dev = !instance.domain;
  if (instance.domain) {
    const { hostname, path = "" } = instance.domain;
    config.routes = path
      ? [{ pattern: hostname + path + "*", zone_name: zoneName! }]
      : [{ pattern: hostname, custom_domain: true }];
    if (path) {
      if (!zoneName) throw new Error("A zone name is required for a path route.");
      (config.vars as TomlTable).BASE_PATH = path;
    }
  }
  const database = (config.d1_databases as TomlTable[]).find((item) => item.binding === "DB");
  const bucket = (config.r2_buckets as TomlTable[]).find((item) => item.binding === "MEDIA");
  if (!database || !bucket) throw new Error("wrangler.toml must contain DB and MEDIA bindings.");
  database.database_name = instance.d1_name ?? instance.worker_name;
  database.database_id = databaseId;
  bucket.bucket_name = instance.r2_bucket ?? instance.worker_name + "-media";
  return config;
}

export function parseAccountId(content: Uint8Array): string {
  const source = new TextDecoder().decode(content);
  const records = JSON.parse(source.slice(source.indexOf("=") + 1).trim().replace(/;\s*$/, ""));
  const id = records[0]?.account?.accountId;
  if (typeof id !== "string" || !id) throw new Error("Archive data/account.js has no accountId.");
  return id;
}

export { parse, stringify };
