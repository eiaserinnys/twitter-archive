import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeTweetText, tweetTextUrlEntities, type TweetUrlEntity } from "../src/shared/tweet-text.js";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString } from "./lib/cli.js";
import { estimateXLookupCostUsd, X_POSTS_PER_REQUEST } from "./lib/x-api-cost.js";

type ContextColumn = "parent_text" | "quoted_text";
type TextColumn = "text" | ContextColumn;

interface CandidateRow {
  id: string;
  text?: string | null;
  parent_id?: string | null;
  parent_text?: string | null;
  quoted_id?: string | null;
  quoted_text?: string | null;
}

interface TweetTarget {
  id: string;
  fields: Array<{ rowId: string; column: TextColumn; text: string }>;
}

interface XPost {
  id: string;
  text?: string;
  note_tweet?: { text?: string; entities?: { urls?: TweetUrlEntity[] } };
  entities?: { urls?: TweetUrlEntity[] };
}

interface XLookupResponse {
  data?: XPost[];
}

export interface RepairLinksOptions {
  inputPath: string;
  outputPath: string;
  maxUsd: number;
  bearerToken: string;
  fetchImpl?: typeof fetch;
}

export interface RepairLinksResult {
  requestedPosts: number;
  updatedRows: number;
  unavailablePosts: number;
  stoppedForBudget: boolean;
  estimatedCostUsd: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function candidateRows(value: unknown): CandidateRow[] {
  const topLevel = Array.isArray(value) ? value : undefined;
  const directRows = topLevel?.every((item) => record(item)?.results === undefined) ? topLevel : undefined;
  if (directRows) return directRows.map((item) => candidateRow(item));
  const result = topLevel ? record(topLevel[0]) : record(value);
  const rows = result?.results;
  if (!Array.isArray(rows)) throw new Error("Input JSON does not contain a wrangler D1 results array.");
  return rows.map((item) => candidateRow(item));
}

function candidateRow(value: unknown): CandidateRow {
  const row = record(value);
  if (!row || typeof row.id !== "string") throw new Error("A candidate row is missing its id.");
  return {
    id: row.id,
    text: typeof row.text === "string" ? row.text : null,
    parent_id: typeof row.parent_id === "string" ? row.parent_id : null,
    parent_text: typeof row.parent_text === "string" ? row.parent_text : null,
    quoted_id: typeof row.quoted_id === "string" ? row.quoted_id : null,
    quoted_text: typeof row.quoted_text === "string" ? row.quoted_text : null,
  };
}

function isShortLinkText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.includes("t.co/");
}

function collectTargets(rows: CandidateRow[]): TweetTarget[] {
  const targets = new Map<string, TweetTarget>();
  const add = (tweetId: string | null | undefined, rowId: string, column: TextColumn, text: string | null | undefined): void => {
    if (!tweetId || !isShortLinkText(text)) return;
    const target = targets.get(tweetId) ?? { id: tweetId, fields: [] };
    target.fields.push({ rowId, column, text });
    targets.set(tweetId, target);
  };
  for (const row of rows) {
    add(row.id, row.id, "text", row.text);
    add(row.parent_id, row.id, "parent_text", row.parent_text);
    add(row.quoted_id, row.id, "quoted_text", row.quoted_text);
  }
  return [...targets.values()];
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function topLevelMediaUrls(post: XPost): Set<string> {
  return new Set((post.entities?.urls ?? [])
    .filter((url) => url.media_key)
    .map((url) => url.url)
    .filter((url): url is string => Boolean(url)));
}

function normalizePostText(post: XPost): string {
  const noteText = post.note_tweet?.text;
  const text = typeof noteText === "string" && noteText.length > 0 ? noteText : post.text ?? "";
  return normalizeTweetText(text, tweetTextUrlEntities(post), topLevelMediaUrls(post));
}

async function lookupBatch(
  ids: string[],
  token: string,
  fetchImpl: typeof fetch,
): Promise<XLookupResponse> {
  const params = new URLSearchParams({
    ids: ids.join(","),
    "tweet.fields": "text,note_tweet,entities",
  });
  const request = () => fetchImpl(`https://api.x.com/2/tweets?${params}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const response = await request();
  if (!response.ok) throw new Error(`X API HTTP ${response.status} while repairing tweet links.`);
  return await response.json() as XLookupResponse;
}

function updateStatement(rowId: string, column: TextColumn, text: string): string {
  return `UPDATE tweets SET ${column} = ${sqlString(text)} WHERE id = ${sqlString(rowId)};`;
}

export async function runRepairLinks(options: RepairLinksOptions): Promise<RepairLinksResult> {
  if (!Number.isFinite(options.maxUsd) || options.maxUsd < 0) throw new Error("--max-usd must be a non-negative number.");
  const input = JSON.parse(await readFile(options.inputPath, "utf8")) as unknown;
  const targets = collectTargets(candidateRows(input));
  const fetchImpl = options.fetchImpl ?? fetch;
  const postsById = new Map<string, XPost>();
  const attemptedIds = new Set<string>();
  let requestedPosts = 0;
  let spentUsd = 0;
  let stoppedForBudget = false;

  for (let offset = 0; offset < targets.length; offset += X_POSTS_PER_REQUEST) {
    const batch = targets.slice(offset, offset + X_POSTS_PER_REQUEST);
    const maximumBatchCost = estimateXLookupCostUsd(batch.length, 0);
    if (spentUsd + maximumBatchCost > options.maxUsd) {
      stoppedForBudget = true;
      break;
    }
    for (const target of batch) attemptedIds.add(target.id);
    const response = await lookupBatch(batch.map((target) => target.id), options.bearerToken, fetchImpl);
    const posts = response.data ?? [];
    for (const post of posts) postsById.set(post.id, post);
    requestedPosts += posts.length;
    spentUsd += estimateXLookupCostUsd(posts.length, 0);
  }

  const statements: string[] = [];
  for (const target of targets) {
    const post = postsById.get(target.id);
    if (!post) continue;
    const text = normalizePostText(post);
    for (const field of target.fields) {
      if (field.text !== text) statements.push(updateStatement(field.rowId, field.column, text));
    }
  }
  const unavailablePosts = targets.filter((target) => attemptedIds.has(target.id) && !postsById.has(target.id)).length;
  const version = String(Date.now());
  statements.push(`INSERT INTO meta (key, value) VALUES ('data_version', ${sqlString(version)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${statements.join("\n")}\n`, "utf8");
  return {
    requestedPosts,
    updatedRows: statements.length - 1,
    unavailablePosts,
    stoppedForBudget,
    estimatedCostUsd: spentUsd,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    input: { type: "string" },
    output: { type: "string" },
    "max-usd": { type: "string" },
  });
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) throw new Error("X_BEARER_TOKEN is required.");
  const result = await runRepairLinks({
    inputPath: requiredString(args.input, "input"),
    outputPath: requiredString(args.output, "output"),
    maxUsd: Number(requiredString(args["max-usd"], "max-usd")),
    bearerToken,
  });
  console.log(`Checked ${result.requestedPosts} tweets, updated ${result.updatedRows} rows, skipped ${result.unavailablePosts} unavailable tweets; estimated cost $${result.estimatedCostUsd.toFixed(5)}${result.stoppedForBudget ? "; stopped at budget" : ""}.`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
