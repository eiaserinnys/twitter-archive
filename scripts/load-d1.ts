import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../src/shared/jsonl.js";
import { TOPIC_SEED, type TopicSeedConfig } from "../src/shared/topics.js";
import type { NormalizedTweet } from "../src/shared/types.js";
import { isDirectExecution, parseCliArgs, reportCliError, selectedMode } from "./lib/cli.js";
import { readTopicSeed } from "./lib/topics.js";

interface ScoreRow {
  id: string;
  scores: Record<string, number>;
  version: string;
  input_tokens: number;
}

function sqlValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot write a non-finite numeric value to D1.");
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function insertStatements(table: string, columns: string[], rows: Array<Array<string | number | null | undefined>>, conflict?: string): string[] {
  const statements: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const values = batch.map((row) => `(${row.map(sqlValue).join(", ")})`).join(",\n");
    const insert = table === "topics" ? "INSERT OR IGNORE" : conflict ? "INSERT" : "INSERT OR REPLACE";
    statements.push(`${insert} INTO ${table} (${columns.join(", ")}) VALUES\n${values}${conflict ? " " + conflict : ""};`);
  }
  return statements;
}

export function buildSql(tweets: NormalizedTweet[], scores: ScoreRow[], topicSeed: TopicSeedConfig = TOPIC_SEED): string {
  const statements: string[] = [];
  const topicRows = topicSeed.topics.map((topic, index) => [
    topic.id,
    topic.label,
    topic.question,
    topic.version ?? topicSeed.version,
    index + 1,
    1,
    topic.timeline_visibility ?? "public",
    topic.search_visibility ?? "public",
    topic.public_hide_threshold,
  ]);
  statements.push(...insertStatements("topics", [
    "id", "label", "question", "version", "sort_order", "active",
    "timeline_visibility", "search_visibility", "public_hide_threshold",
  ], topicRows));

  const tweetRows = tweets.map((tweet) => [
    tweet.id,
    tweet.created_at_utc,
    tweet.date_kst,
    tweet.year,
    tweet.month,
    tweet.kind,
    tweet.text,
    tweet.text.toLowerCase().includes("x.com/i/article/") ? null : "",
    tweet.parent?.id,
    tweet.parent?.text || null,
    tweet.parent?.author || null,
    tweet.quoted?.id,
    tweet.quoted?.text || null,
    tweet.lang,
    tweet.source,
  ]);
  statements.push(...insertStatements("tweets", [
    "id", "created_at", "date_kst", "year", "month", "kind", "text",
    "article_title", "parent_id", "parent_text", "parent_author", "quoted_id", "quoted_text", "lang", "source",
  ], tweetRows, "ON CONFLICT(id) DO UPDATE SET " + [
    "created_at", "date_kst", "year", "month", "kind", "text", "parent_id", "parent_text",
    "parent_author", "quoted_id", "quoted_text", "lang", "source",
  ].map((column) => column + " = excluded." + column).join(", ")));

  const mediaRows = tweets.flatMap((tweet) => tweet.media.map((media, index) => [
    tweet.id,
    index,
    media.type,
    media.r2_key ?? null,
    media.width ?? null,
    media.height ?? null,
    media.alt ?? null,
  ]));
  statements.push(...insertStatements("media", ["tweet_id", "idx", "type", "r2_key", "width", "height", "alt"], mediaRows,
    "ON CONFLICT(tweet_id, idx) DO UPDATE SET type = excluded.type, width = excluded.width, height = excluded.height, alt = excluded.alt, r2_key = COALESCE(excluded.r2_key, media.r2_key)"));

  const scoreRows = scores.flatMap((row) => topicSeed.topics.flatMap((topic) => {
    const score = row.scores[topic.id];
    if (typeof score !== "number") return [];
    return [[row.id, topic.id, score, topic.version ?? topicSeed.version] as Array<string | number>];
  }));
  statements.push(...insertStatements("scores", ["tweet_id", "topic", "score", "version"], scoreRows));

  const maxTweetId = tweets.reduce<string | null>((maximum, tweet) => {
    if (maximum === null || BigInt(tweet.id) > BigInt(maximum)) return tweet.id;
    return maximum;
  }, null);
  statements.push(...insertStatements("meta", ["key", "value"], [["last_import_at", new Date().toISOString()]]));
  if (maxTweetId !== null) statements.push(...insertStatements("meta", ["key", "value"], [["max_tweet_id", maxTweetId]]));
  statements.push(`INSERT INTO meta (key, value) VALUES ('data_version', ${sqlValue(String(Date.now()))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
  return `${statements.join("\n\n")}\n`;
}

export interface LoadD1Options {
  dataDir: string;
  mode?: "local" | "remote";
  sqlite?: string;
  topics?: TopicSeedConfig;
  wranglerConfig?: string;
}

export async function loadD1(options: LoadD1Options): Promise<{ tweets: number; scores: number; media: number; topics: number }> {
  const topicSeed = options.topics ?? TOPIC_SEED;
  const dataDir = resolve(options.dataDir);
  const tweets = await readJsonl<NormalizedTweet>(resolve(dataDir, "tweets.jsonl"));
  let scores: ScoreRow[] = [];
  try {
    scores = await readJsonl<ScoreRow>(resolve(dataDir, "scores.jsonl"));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(dataDir, { recursive: true });
  const sqlPath = resolve(dataDir, "load-d1.sql");
  await writeFile(sqlPath, buildSql(tweets, scores, topicSeed), "utf8");
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  if (options.sqlite) {
    const sqlite = new DatabaseSync(options.sqlite);
    try { sqlite.exec(await readFile(sqlPath, "utf8")); }
    finally { sqlite.close(); }
  } else execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--file", sqlPath, `--${options.mode}`,
    ...(options.wranglerConfig ? ["--config", options.wranglerConfig] : [])], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return {
    tweets: tweets.length,
    scores: scores.length,
    media: tweets.reduce((total, tweet) => total + tweet.media.length, 0),
    topics: topicSeed.topics.length,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    "data-dir": { type: "string" },
    local: { type: "boolean" },
    remote: { type: "boolean" },
    topics: { type: "string" },
    "wrangler-config": { type: "string" },
    sqlite: { type: "string" },
  });
  const mode = args.sqlite ? undefined : selectedMode(args.local as boolean | undefined, args.remote as boolean | undefined);
  const result = await loadD1({
    dataDir: typeof args["data-dir"] === "string" ? args["data-dir"] : "./data",
    mode,
    sqlite: typeof args.sqlite === "string" ? args.sqlite : undefined,
    wranglerConfig: typeof args["wrangler-config"] === "string" ? args["wrangler-config"] : undefined,
    topics: await readTopicSeed(typeof args.topics === "string" ? args.topics : undefined),
  });
  console.log(`Loaded ${result.tweets} tweets, ${result.scores} score rows, ${result.media} media rows, and ${result.topics} topic seeds (${mode ?? "sqlite"}).`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
