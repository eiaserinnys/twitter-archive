import type { NormalizedTweet, TweetContext, TweetKind, TweetMedia, MediaType } from "../shared/types.js";
import { buildState } from "../shared/tweet-state.js";
import { callJev, JEV_USD_PER_MILLION_INPUT, type JevQuestion, type JevRequest } from "../shared/jev-client.js";
import { queryIdChunks } from "./db/chunked.js";
import type { D1PreparedStatement, Env } from "./env.js";

export interface MissingTopic {
  id: string;
  question: string;
}

interface VersionedTopic extends MissingTopic {
  version: string;
}

interface TweetRow {
  id: string;
  created_at: string;
  date_kst: string;
  year: number;
  month: number;
  kind: TweetKind;
  text: string;
  parent_id: string | null;
  parent_text: string | null;
  parent_author: string | null;
  quoted_id: string | null;
  quoted_text: string | null;
  lang: string | null;
  source: "archive" | "api";
}

interface PendingTopicRow extends VersionedTopic {
  tweet_id: string;
}

interface MediaRow extends TweetMedia {
  tweet_id: string;
  type: MediaType;
}

interface ScoreCandidate {
  tweet: NormalizedTweet;
  topics: VersionedTopic[];
}

interface RescoreJob {
  key: string;
  value: string;
}

interface RescoreState {
  version: string;
  cursor: string;
}

export function buildJevRequest(tweet: NormalizedTweet, topics: MissingTopic[]): JevRequest {
  const questions = Object.fromEntries(topics.map((topic) => [topic.id, {
    type: "noul" as const,
    instructions: `이 트윗은 ${topic.question}에 관한 이야기인가?`,
    criteria: { true: "그렇다", false: "아니다" },
  } satisfies JevQuestion]));
  return { state: buildState(tweet), questions };
}

export function canReserveJevSpend(spentUsd: number, reservedUsd: number, nextUsd: number, capUsd: number): boolean {
  return spentUsd + reservedUsd + nextUsd <= capUsd;
}

function estimateInputTokens(request: JevRequest): number {
  const payload = { state: request.state, model: "jev-latest", questions: request.questions };
  const byteLength = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  return Math.max(2048, Math.ceil(byteLength * 0.6 + 2048));
}

function tweetContext(id: string | null, text: string | null, author?: string | null): TweetContext | null {
  if (!id) return null;
  return { id, text: text ?? "", ...(author ? { author } : {}) };
}

async function candidatesForTweets(
  env: Env,
  tweets: TweetRow[],
  topicId?: string,
): Promise<ScoreCandidate[]> {
  if (tweets.length === 0) return [];
  const ids = tweets.map((tweet) => tweet.id);
  const pendingRows = await queryIdChunks(ids, async (chunk) => {
    const placeholders = chunk.map(() => "?").join(", ");
    const topicClause = topicId ? "AND tp.id = ?" : "";
    const result = await env.DB.prepare(`
      SELECT t.id AS tweet_id, tp.id, tp.question, tp.version
      FROM tweets t
      JOIN topics tp ON tp.active = 1
      LEFT JOIN scores s ON s.tweet_id = t.id AND s.topic = tp.id AND s.version = tp.version
      WHERE t.id IN (${placeholders}) AND s.tweet_id IS NULL ${topicClause}
      ORDER BY t.created_at DESC, t.id DESC, tp.sort_order, tp.id
    `).bind(...chunk, ...(topicId ? [topicId] : [])).all<PendingTopicRow>();
    return result.results;
  }, topicId ? 1 : 0);
  const topicsByTweet = new Map<string, VersionedTopic[]>();
  for (const row of pendingRows) {
    const list = topicsByTweet.get(row.tweet_id) ?? [];
    list.push({ id: row.id, question: row.question, version: row.version });
    topicsByTweet.set(row.tweet_id, list);
  }
  const eligibleTweets = tweets.filter((tweet) => topicsByTweet.has(tweet.id));
  if (eligibleTweets.length === 0) return [];
  const eligibleIds = eligibleTweets.map((tweet) => tweet.id);
  const mediaRows = await queryIdChunks(eligibleIds, async (chunk) => {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(`
      SELECT tweet_id, type, r2_key, width, height, alt
      FROM media WHERE tweet_id IN (${placeholders})
      ORDER BY tweet_id, idx
    `).bind(...chunk).all<MediaRow>();
    return result.results;
  });
  const mediaByTweet = new Map<string, TweetMedia[]>();
  for (const row of mediaRows) {
    const list = mediaByTweet.get(row.tweet_id) ?? [];
    list.push({ type: row.type, r2_key: row.r2_key, width: row.width, height: row.height, alt: row.alt });
    mediaByTweet.set(row.tweet_id, list);
  }
  return eligibleTweets.map((row) => ({
    tweet: {
      id: row.id,
      created_at_utc: row.created_at,
      date_kst: row.date_kst,
      year: row.year,
      month: row.month,
      kind: row.kind,
      text: row.text,
      parent: tweetContext(row.parent_id, row.parent_text, row.parent_author),
      quoted: tweetContext(row.quoted_id, row.quoted_text),
      lang: row.lang,
      source: row.source,
      media: mediaByTweet.get(row.id) ?? [],
    },
    topics: topicsByTweet.get(row.id) ?? [],
  }));
}

async function recentPendingTweets(env: Env, limit: number): Promise<TweetRow[]> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(`
    SELECT t.id, t.created_at, t.date_kst, t.year, t.month, t.kind, t.text,
      t.parent_id, t.parent_text, t.parent_author, t.quoted_id, t.quoted_text, t.lang, t.source
    FROM tweets t
    WHERE t.created_at >= ? AND EXISTS (
      SELECT 1 FROM topics tp
      LEFT JOIN scores s ON s.tweet_id = t.id AND s.topic = tp.id AND s.version = tp.version
      WHERE tp.active = 1 AND s.tweet_id IS NULL
    )
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ?
  `).bind(cutoff, limit).all<TweetRow>();
  return result.results;
}

async function tweetsByIds(env: Env, ids: string[]): Promise<TweetRow[]> {
  return queryIdChunks(ids, async (chunk) => {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(`
      SELECT id, created_at, date_kst, year, month, kind, text,
        parent_id, parent_text, parent_author, quoted_id, quoted_text, lang, source
      FROM tweets WHERE id IN (${placeholders})
      ORDER BY created_at DESC, id DESC
    `).bind(...chunk).all<TweetRow>();
    return result.results;
  });
}

function scoreValues(request: JevRequest, answers: Record<string, { noul?: number }>): Array<{ id: string; score: number }> {
  return Object.keys(request.questions).map((id) => {
    const score = answers[id]?.noul;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`Jev response has an invalid ${id} score.`);
    }
    return { id, score };
  });
}

function scoreStatements(
  env: Env,
  tweetId: string,
  topics: VersionedTopic[],
  scores: Array<{ id: string; score: number }>,
  monthKey: string,
  costUsd: number,
): D1PreparedStatement[] {
  const versionByTopic = new Map(topics.map((topic) => [topic.id, topic.version]));
  const statements = scores.map(({ id, score }) => env.DB.prepare(`
    INSERT OR REPLACE INTO scores (tweet_id, topic, score, version) VALUES (?, ?, ?, ?)
  `).bind(tweetId, id, score, versionByTopic.get(id)));
  statements.push(env.DB.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS REAL) + CAST(excluded.value AS REAL)
  `).bind(monthKey, String(costUsd)));
  return statements;
}

function scoreBatchSize(env: Env): number {
  const batchSize = Number(env.SCORE_BATCH);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("SCORE_BATCH must be a positive integer.");
  return batchSize;
}

async function scoreWork(env: Env, work: ScoreCandidate[]): Promise<{
  scored: number;
  stoppedForBudget: boolean;
  failed: number;
}> {
  const capUsd = Number(env.JEV_MONTHLY_USD_CAP);
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error("JEV_MONTHLY_USD_CAP must be a non-negative number.");
  if (work.length === 0) return { scored: 0, stoppedForBudget: false, failed: 0 };

  const monthKey = `jev_usd:${new Date().toISOString().slice(0, 7)}`;
  const usageRow = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(monthKey).first<{ value: string | null }>();
  let spentUsd = usageRow?.value === null || usageRow?.value === undefined ? 0 : Number(usageRow.value);
  if (!Number.isFinite(spentUsd) || spentUsd < 0) throw new Error(`Invalid Jev monthly usage in ${monthKey}.`);

  let reservedUsd = 0;
  let nextIndex = 0;
  let scored = 0;
  let failed = 0;
  let stoppedForBudget = spentUsd >= capUsd;
  const worker = async (): Promise<void> => {
    while (nextIndex < work.length) {
      const item = work[nextIndex];
      const request = buildJevRequest(item.tweet, item.topics);
      const estimatedCostUsd = estimateInputTokens(request) * JEV_USD_PER_MILLION_INPUT / 1_000_000;
      if (!canReserveJevSpend(spentUsd, reservedUsd, estimatedCostUsd, capUsd)) {
        stoppedForBudget = true;
        return;
      }
      nextIndex += 1;
      reservedUsd += estimatedCostUsd;

      let result;
      let scores: Array<{ id: string; score: number }>;
      try {
        if (!env.TYPESAFE_BASE_URL || !env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_BASE_URL and TYPESAFE_API_KEY are required for Jev scoring.");
        result = await callJev({ baseUrl: env.TYPESAFE_BASE_URL, apiKey: env.TYPESAFE_API_KEY }, request);
        scores = scoreValues(request, result.answers);
      } catch (error) {
        console.error(`Could not score tweet ${item.tweet.id}; it will remain pending.`, error);
        reservedUsd -= estimatedCostUsd;
        failed += 1;
        continue;
      }

      const costUsd = result.inputTokens * JEV_USD_PER_MILLION_INPUT / 1_000_000;
      const statements = scoreStatements(env, item.tweet.id, item.topics, scores, monthKey, costUsd);
      if (!env.DB.batch) throw new Error("D1 batch execution is unavailable.");
      const results = await env.DB.batch(statements);
      if (results.some((statement) => !statement.success)) throw new Error(`D1 rejected scores for tweet ${item.tweet.id}.`);
      spentUsd += costUsd;
      scored += 1;
      reservedUsd -= estimatedCostUsd;
    }
  };

  await Promise.all(Array.from({ length: Math.min(6, work.length) }, () => worker()));
  return { scored, stoppedForBudget, failed };
}

export async function scoreCollectedTweets(env: Env, ids: string[]): Promise<{ scored: number; stoppedForBudget: boolean }> {
  scoreBatchSize(env);
  const tweets = await tweetsByIds(env, [...new Set(ids)]);
  const work = await candidatesForTweets(env, tweets);
  const result = await scoreWork(env, work);
  return { scored: result.scored, stoppedForBudget: result.stoppedForBudget };
}

export async function scorePendingTweets(env: Env): Promise<{ scored: number; stoppedForBudget: boolean }> {
  const batchSize = scoreBatchSize(env);
  const tweets = await recentPendingTweets(env, batchSize);
  const work = await candidatesForTweets(env, tweets);
  const result = await scoreWork(env, work);
  return { scored: result.scored, stoppedForBudget: result.stoppedForBudget };
}

async function removeRescoreJob(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("DELETE FROM meta WHERE key = ? AND value = ?").bind(key, value).run();
}

export async function processRescoreJobs(env: Env): Promise<{ scored: number; stoppedForBudget: boolean }> {
  const jobs = await env.DB.prepare(`
    SELECT key, value FROM meta WHERE key >= 'rescore:' AND key < 'rescore;'
  `).all<RescoreJob>();
  if (jobs.results.length === 0) return { scored: 0, stoppedForBudget: false };

  const batchSize = scoreBatchSize(env);
  let scored = 0;
  let stoppedForBudget = false;
  for (const job of jobs.results) {
    const state = JSON.parse(job.value) as RescoreState;
    const topic = await env.DB.prepare("SELECT version, active FROM topics WHERE id = ?")
      .bind(job.key.slice("rescore:".length)).first<{ version: string; active: number }>();
    if (!topic || !topic.active || topic.version !== state.version) {
      await removeRescoreJob(env, job.key, job.value);
      continue;
    }

    const tweets = await env.DB.prepare(`
      SELECT id, created_at, date_kst, year, month, kind, text,
        parent_id, parent_text, parent_author, quoted_id, quoted_text, lang, source
      FROM tweets WHERE id > ? ORDER BY id LIMIT ?
    `).bind(state.cursor, batchSize).all<TweetRow>();
    if (tweets.results.length === 0) {
      await removeRescoreJob(env, job.key, job.value);
      continue;
    }

    const topicId = job.key.slice("rescore:".length);
    const work = await candidatesForTweets(env, tweets.results, topicId);
    const result = await scoreWork(env, work);
    scored += result.scored;
    if (result.failed > 0 || result.stoppedForBudget) {
      stoppedForBudget ||= result.stoppedForBudget;
      if (result.stoppedForBudget) break;
      continue;
    }

    if (tweets.results.length < batchSize) {
      await removeRescoreJob(env, job.key, job.value);
    } else {
      const nextState = JSON.stringify({ version: state.version, cursor: tweets.results[tweets.results.length - 1].id });
      await env.DB.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
        .bind(nextState, job.key, job.value).run();
    }
  }
  return { scored, stoppedForBudget };
}
