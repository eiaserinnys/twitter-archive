import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { TOPIC_SEED, type TopicSeedConfig } from "../src/shared/topics.js";
import { readJsonl, writeJsonl } from "../src/shared/jsonl.js";
import { JEV_USD_PER_MILLION_INPUT } from "../src/shared/jev-client.js";
import { buildState } from "../src/shared/tweet-state.js";
import type { NormalizedTweet } from "../src/shared/types.js";
import { isDirectExecution, parseCliArgs, reportCliError } from "./lib/cli.js";
import { readTopicSeed } from "./lib/topics.js";

export interface JevPayload {
  state: string;
  model: "jev-latest";
  questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }>;
}

export interface ScoreOptions {
  dataDir: string;
  maxUsd: number;
  dryRun: boolean;
  baseUrl: string;
  apiKey: string;
  limit?: number;
  topics?: TopicSeedConfig;
  fetchImpl?: typeof fetch;
}

export interface ScoreResult {
  scored: number;
  dryRunStates: number;
  stoppedForBudget: boolean;
}

export { buildState } from "../src/shared/tweet-state.js";

export function buildPayload(tweet: NormalizedTweet, topicSeed: TopicSeedConfig = TOPIC_SEED): JevPayload {
  const questions = Object.fromEntries(topicSeed.topics.map((topic) => [topic.id, {
    type: "noul" as const,
    instructions: `이 트윗은 ${topic.question}에 관한 이야기인가?`,
    criteria: { true: "그렇다", false: "아니다" },
  }]));
  return { state: buildState(tweet), model: "jev-latest", questions };
}

function estimateInputTokens(payload: JevPayload): number {
  const byteLength = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  return Math.max(2048, Math.ceil(byteLength * 0.6 + 2048));
}

function parseResponse(body: unknown, topicSeed: TopicSeedConfig = TOPIC_SEED): { scores: Record<string, number>; inputTokens: number } {
  if (!body || typeof body !== "object" || !("answers" in body) || !body.answers || typeof body.answers !== "object") {
    throw new Error("Jev response has no answers object.");
  }
  const answers = body.answers as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const topic of topicSeed.topics) {
    const answer = answers[topic.id];
    const value = answer && typeof answer === "object" && "noul" in answer ? answer.noul : undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Jev response has an invalid ${topic.id} score.`);
    }
    scores[topic.id] = value;
  }
  const usage = "usage" in body && body.usage && typeof body.usage === "object" ? body.usage : undefined;
  const inputTokens = usage && "input_tokens" in usage ? usage.input_tokens : undefined;
  if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error("Jev response has invalid input_tokens.");
  }
  return { scores, inputTokens };
}

async function existingScores(path: string): Promise<Array<{ id: string; version: string; input_tokens: number }>> {
  try {
    return await readJsonl(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function runScore(options: ScoreOptions): Promise<ScoreResult> {
  const topicSeed = options.topics ?? TOPIC_SEED;
  const tweets = await readJsonl<NormalizedTweet>(resolve(options.dataDir, "tweets.jsonl"));
  const scoresPath = resolve(options.dataDir, "scores.jsonl");
  const previous = await existingScores(scoresPath);
  const scoredVersion = new Map(previous.filter((row) => row.version === topicSeed.version).map((row) => [row.id, row.version]));
  const candidates = tweets.filter((tweet) => !scoredVersion.has(tweet.id)).slice(0, options.limit);
  if (options.dryRun) {
    const rows = candidates.map((tweet) => ({ id: tweet.id, state: buildState(tweet) }));
    await writeJsonl(resolve(options.dataDir, "score-inputs.jsonl"), rows);
    return { scored: 0, dryRunStates: rows.length, stoppedForBudget: false };
  }

  await mkdir(options.dataDir, { recursive: true });
  const fetchImpl = options.fetchImpl ?? fetch;
  let spentTokens = previous.reduce((total, row) => total + row.input_tokens, 0);
  let reservedCostUsd = 0;
  let nextIndex = 0;
  let scored = 0;
  let stoppedForBudget = false;
  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const tweet = candidates[nextIndex];
      const payload = buildPayload(tweet, topicSeed);
      const estimatedCostUsd = estimateInputTokens(payload) * JEV_USD_PER_MILLION_INPUT / 1_000_000;
      const spentUsd = spentTokens * JEV_USD_PER_MILLION_INPUT / 1_000_000;
      if (spentUsd + reservedCostUsd + estimatedCostUsd > options.maxUsd) {
        stoppedForBudget = true;
        return;
      }
      nextIndex += 1;
      reservedCostUsd += estimatedCostUsd;
      try {
        const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`Jev HTTP ${response.status} while scoring a tweet.`);
        const result = parseResponse(await response.json(), topicSeed);
        spentTokens += result.inputTokens;
        scored += 1;
        await appendFile(scoresPath, `${JSON.stringify({ id: tweet.id, scores: result.scores, version: topicSeed.version, input_tokens: result.inputTokens })}\n`);
      } finally {
        reservedCostUsd -= estimatedCostUsd;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { scored, dryRunStates: 0, stoppedForBudget };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    "data-dir": { type: "string" },
    "max-usd": { type: "string" },
    limit: { type: "string" },
    topics: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  const dryRun = Boolean(args["dry-run"]);
  const topics = await readTopicSeed(typeof args.topics === "string" ? args.topics : undefined);
  const baseUrl = process.env.TYPESAFE_BASE_URL;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!dryRun && !baseUrl) throw new Error("TYPESAFE_BASE_URL is required.");
  if (!dryRun && !apiKey) throw new Error("TYPESAFE_API_KEY is required.");
  const result = await runScore({
    dataDir: typeof args["data-dir"] === "string" ? args["data-dir"] : "./data",
    maxUsd: typeof args["max-usd"] === "string" ? Number(args["max-usd"]) : 2,
    limit: typeof args.limit === "string" ? Number(args.limit) : undefined,
    dryRun,
    baseUrl: baseUrl ?? "",
    apiKey: apiKey ?? "",
    topics,
  });
  if (result.dryRunStates > 0) console.log(`Built ${result.dryRunStates} scoring states; no Jev requests were sent.`);
  else console.log(`Scored ${result.scored} tweets${result.stoppedForBudget ? "; stopped at budget" : ""}.`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
