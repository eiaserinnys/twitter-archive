import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

function insertStatements(table: string, columns: string[], rows: Array<Array<string | number | null | undefined>>): string[] {
  const statements: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const values = batch.map((row) => `(${row.map(sqlValue).join(", ")})`).join(",\n");
    statements.push(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES\n${values};`);
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
  ]);
  statements.push(...insertStatements("topics", ["id", "label", "question", "version", "sort_order", "active"], topicRows));

  const tweetRows = tweets.map((tweet) => [
    tweet.id,
    tweet.created_at_utc,
    tweet.date_kst,
    tweet.year,
    tweet.month,
    tweet.kind,
    tweet.text,
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
    "parent_id", "parent_text", "parent_author", "quoted_id", "quoted_text", "lang", "source",
  ], tweetRows));

  const mediaRows = tweets.flatMap((tweet) => tweet.media.map((media, index) => [
    tweet.id,
    index,
    media.type,
    media.r2_key ?? null,
    media.width ?? null,
    media.height ?? null,
    media.alt ?? null,
  ]));
  statements.push(...insertStatements("media", ["tweet_id", "idx", "type", "r2_key", "width", "height", "alt"], mediaRows));

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
  mode: "local" | "remote";
  topics?: TopicSeedConfig;
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
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--file", sqlPath, `--${options.mode}`], {
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
  });
  const mode = selectedMode(args.local as boolean | undefined, args.remote as boolean | undefined);
  const result = await loadD1({
    dataDir: typeof args["data-dir"] === "string" ? args["data-dir"] : "./data",
    mode,
    topics: await readTopicSeed(typeof args.topics === "string" ? args.topics : undefined),
  });
  console.log(`Loaded ${result.tweets} tweets, ${result.scores} score rows, ${result.media} media rows, and ${result.topics} topic seeds (${mode}).`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
