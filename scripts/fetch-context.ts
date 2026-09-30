import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readJsonl, writeJsonl } from "../src/shared/jsonl.js";
import { normalizeTweetText, tweetTextUrlEntities, type TweetUrlEntity } from "../src/shared/tweet-text.js";
import type { NormalizedTweet, TweetContext } from "../src/shared/types.js";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString } from "./lib/cli.js";
import { estimateXLookupCostUsd, X_POSTS_PER_REQUEST } from "./lib/x-api-cost.js";

interface ContextTarget {
  id: string;
  contexts: Array<{ row: NormalizedTweet; field: "parent" | "quoted" }>;
}

interface XPost {
  id: string;
  text?: string;
  author_id?: string;
  entities?: { urls?: TweetUrlEntity[] };
  note_tweet?: { text?: string; entities?: { urls?: TweetUrlEntity[] } };
}

interface XLookupResponse {
  data?: XPost[];
  includes?: { users?: Array<{ id: string; username: string }> };
}

function mediaUrls(tweet: XPost): Set<string> {
  return new Set((tweet.entities?.urls ?? [])
    .filter((url) => url.media_key)
    .map((url) => url.url)
    .filter((url): url is string => Boolean(url)));
}

export interface FetchContextOptions {
  dataDir: string;
  maxUsd: number;
  bearerToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface FetchContextResult {
  requestedPosts: number;
  stoppedForBudget: boolean;
  estimatedCostUsd: number;
}

export function missingContextTargets(tweets: NormalizedTweet[]): ContextTarget[] {
  const targets = new Map<string, ContextTarget>();
  for (const row of tweets) {
    const fields: Array<["parent" | "quoted", TweetContext | null]> = [
      ["parent", row.parent],
      ["quoted", row.quoted],
    ];
    for (const [field, context] of fields) {
      if (!context?.id || context.text) continue;
      if (field === "parent" && row.kind !== "reply" && row.kind !== "self_reply") continue;
      if (field === "quoted" && row.kind !== "quote") continue;
      const target = targets.get(context.id) ?? { id: context.id, contexts: [] };
      target.contexts.push({ row, field });
      targets.set(context.id, target);
    }
  }
  return [...targets.values()];
}

async function lookupBatch(
  ids: string[],
  token: string,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<XLookupResponse> {
  const params = new URLSearchParams({
    ids: ids.join(","),
    "tweet.fields": "text,note_tweet,author_id,entities",
    expansions: "author_id",
    "user.fields": "username",
  });
  const request = () => fetchImpl(`https://api.x.com/2/tweets?${params}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  let response = await request();
  if (response.status === 429) {
    await sleep(60_000);
    response = await request();
  }
  if (!response.ok) throw new Error(`X API HTTP ${response.status} while fetching context.`);
  return await response.json() as XLookupResponse;
}

export async function runFetchContext(options: FetchContextOptions): Promise<FetchContextResult> {
  const tweetsPath = resolve(options.dataDir, "tweets.jsonl");
  const tweets = await readJsonl<NormalizedTweet>(tweetsPath);
  const targets = missingContextTargets(tweets);
  const errors: Array<{ id: string; reason: string }> = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let requestedPosts = 0;
  let spentUsd = 0;
  let stoppedForBudget = false;

  for (let offset = 0; offset < targets.length; offset += X_POSTS_PER_REQUEST) {
    const batch = targets.slice(offset, offset + X_POSTS_PER_REQUEST);
    const maximumBatchCost = estimateXLookupCostUsd(batch.length, batch.length);
    if (spentUsd + maximumBatchCost > options.maxUsd) {
      stoppedForBudget = true;
      break;
    }
    const response = await lookupBatch(batch.map((target) => target.id), options.bearerToken, fetchImpl, sleep);
    const posts = response.data ?? [];
    const usernames = new Map((response.includes?.users ?? []).map((user) => [user.id, user.username]));
    const postsById = new Map(posts.map((post) => [post.id, post]));
    for (const target of batch) {
      const post = postsById.get(target.id);
      if (!post) {
        errors.push({ id: target.id, reason: "unavailable" });
        continue;
      }
      const noteText = post.note_tweet?.text;
      const text = typeof noteText === "string" && noteText.length > 0 ? noteText : post.text ?? "";
      const normalizedText = normalizeTweetText(text, tweetTextUrlEntities(post), mediaUrls(post));
      for (const { row, field } of target.contexts) {
        const context = row[field];
        if (!context) continue;
        context.text = normalizedText;
        if (field === "parent" && post.author_id) context.author = usernames.get(post.author_id) ?? context.author ?? "";
      }
    }
    const users = response.includes?.users ?? [];
    requestedPosts += posts.length;
    spentUsd += estimateXLookupCostUsd(posts.length, users.length);
  }

  await writeJsonl(tweetsPath, tweets);
  const errorsPath = resolve(options.dataDir, "fetch-context-errors.jsonl");
  await mkdir(options.dataDir, { recursive: true });
  await writeJsonl(errorsPath, errors);
  await appendFile(resolve(options.dataDir, "fetch-context-cost.jsonl"), `${JSON.stringify({ posts: requestedPosts, cost_usd: spentUsd })}\n`);
  return { requestedPosts, stoppedForBudget, estimatedCostUsd: spentUsd };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    "data-dir": { type: "string" },
    "max-usd": { type: "string" },
  });
  const dataDir = typeof args["data-dir"] === "string" ? args["data-dir"] : "./data";
  const maxUsd = typeof args["max-usd"] === "string" ? Number(args["max-usd"]) : 40;
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) throw new Error("X_BEARER_TOKEN is required.");
  const result = await runFetchContext({ dataDir, maxUsd, bearerToken });
  console.log(`Context lookup fetched ${result.requestedPosts} posts; estimated cost $${result.estimatedCostUsd.toFixed(5)}${result.stoppedForBudget ? "; stopped at budget" : ""}.`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
