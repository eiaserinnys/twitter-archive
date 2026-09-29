import { TOPIC_SEED } from "../../shared/topics.js";
import type { Viewer } from "../auth.js";
import type { D1Database } from "../env.js";
import { decodeCursor, encodeCursor, type TweetCursor } from "../cursor.js";
import { selectTweetTopicChips, type TopicScoreRow } from "../visibility.js";
import { serializeTweet, type MediaDbRow, type TweetDbRow, type TweetOut } from "../serialize.js";

export interface TweetFilters {
  year?: number;
  month?: number;
  date?: string;
  from?: string;
  to?: string;
  topics?: string[];
  kinds?: string[];
  q?: string;
  order: "asc" | "desc";
  limit: number;
  cursor?: TweetCursor;
}

export interface TweetListResult {
  tweets: TweetOut[];
  next_cursor: string | null;
  total: number;
}

function visibleTopicClause(viewer: Viewer): string {
  return viewer.viewingAs === "owner"
    ? "tp.timeline_visibility IN ('public', 'owner')"
    : "tp.timeline_visibility = 'public'";
}

function filterWhere(filters: TweetFilters, viewer: Viewer): { sql: string; values: unknown[] } {
  const clauses = ["1 = 1"];
  const values: unknown[] = [];
  if (filters.year !== undefined) {
    clauses.push("t.year = ?");
    values.push(filters.year);
  }
  if (filters.month !== undefined) {
    clauses.push("t.month = ?");
    values.push(filters.month);
  }
  if (filters.date) {
    clauses.push("t.date_kst = ?");
    values.push(filters.date);
  }
  if (filters.from) {
    clauses.push("t.date_kst >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push("t.date_kst <= ?");
    values.push(filters.to);
  }
  if (filters.kinds?.length) {
    clauses.push(`t.kind IN (${filters.kinds.map(() => "?").join(", ")})`);
    values.push(...filters.kinds);
  }
  if (filters.q) {
    clauses.push("instr(lower(t.text), lower(?)) > 0");
    values.push(filters.q);
  }
  if (filters.topics?.length) {
    clauses.push(`EXISTS (
      SELECT 1 FROM scores s
      JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
        AND ${visibleTopicClause(viewer)}
      WHERE s.tweet_id = t.id AND s.score >= ?
        AND s.topic IN (${filters.topics.map(() => "?").join(", ")})
    )`);
    values.push(TOPIC_SEED.display_threshold, ...filters.topics);
  }
  return { sql: clauses.join(" AND "), values };
}

export async function serializeTweetRows(
  db: D1Database,
  rows: TweetDbRow[],
  viewer: Viewer,
): Promise<TweetOut[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");
  const [mediaResult, topicResult] = await Promise.all([
    db.prepare(`
      SELECT tweet_id, type, r2_key, width, height, alt
      FROM media
      WHERE tweet_id IN (${placeholders})
      ORDER BY tweet_id, idx
    `).bind(...ids).all<MediaDbRow & { tweet_id: string }>(),
    db.prepare(`
      SELECT s.tweet_id, tp.id, s.score, s.version, tp.version AS topic_version,
        tp.active, tp.timeline_visibility
      FROM scores s
      JOIN topics tp ON tp.id = s.topic
      WHERE s.tweet_id IN (${placeholders}) AND s.score >= ?
        AND s.version = tp.version AND tp.active = 1
        AND ${visibleTopicClause(viewer)}
    `).bind(...ids, TOPIC_SEED.display_threshold).all<TopicScoreRow & { tweet_id: string }>(),
  ]);
  const mediaByTweet = new Map<string, MediaDbRow[]>();
  for (const row of mediaResult.results) {
    const items = mediaByTweet.get(row.tweet_id) ?? [];
    items.push(row);
    mediaByTweet.set(row.tweet_id, items);
  }
  const topicsByTweet = new Map<string, TopicScoreRow[]>();
  for (const row of topicResult.results) {
    const items = topicsByTweet.get(row.tweet_id) ?? [];
    items.push(row);
    topicsByTweet.set(row.tweet_id, items);
  }
  return rows.map((row) => serializeTweet(
    row,
    mediaByTweet.get(row.id) ?? [],
    selectTweetTopicChips(topicsByTweet.get(row.id) ?? [], viewer, TOPIC_SEED.display_threshold),
  ));
}

export async function queryTweets(
  db: D1Database,
  viewer: Viewer,
  filters: TweetFilters,
): Promise<TweetListResult> {
  const base = filterWhere(filters, viewer);
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM tweets t WHERE ${base.sql}`)
    .bind(...base.values).first<{ total: number }>();
  const pageClauses = [base.sql];
  const pageValues = [...base.values];
  if (filters.cursor) {
    const operator = filters.order === "asc" ? ">" : "<";
    pageClauses.push(`(t.created_at ${operator} ? OR (t.created_at = ? AND t.id ${operator} ?))`);
    pageValues.push(filters.cursor.created_at, filters.cursor.created_at, filters.cursor.id);
  }
  const result = await db.prepare(`
    SELECT t.id, t.created_at, t.date_kst, t.kind, t.text, t.parent_id, t.parent_text,
      t.parent_author, t.quoted_id, t.quoted_text
    FROM tweets t
    WHERE ${pageClauses.join(" AND ")}
    ORDER BY t.created_at ${filters.order.toUpperCase()}, t.id ${filters.order.toUpperCase()}
    LIMIT ?
  `).bind(...pageValues, filters.limit + 1).all<TweetDbRow>();
  const hasMore = result.results.length > filters.limit;
  const rows = result.results.slice(0, filters.limit);
  return {
    tweets: await serializeTweetRows(db, rows, viewer),
    next_cursor: hasMore && rows.length > 0
      ? encodeCursor({ created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id })
      : null,
    total: count?.total ?? 0,
  };
}

export interface OnThisDayTweetRow extends TweetDbRow {
  date_kst: string;
  day_total: number;
}

export async function getOnThisDayTweets(
  db: D1Database,
  dates: string[],
): Promise<OnThisDayTweetRow[]> {
  if (dates.length === 0) return [];
  const placeholders = dates.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT id, created_at, date_kst, kind, text, parent_id, parent_text, parent_author,
      quoted_id, quoted_text, day_total
    FROM (
      SELECT t.id, t.created_at, t.date_kst, t.kind, t.text, t.parent_id, t.parent_text,
        t.parent_author, t.quoted_id, t.quoted_text,
        COUNT(*) OVER (PARTITION BY t.date_kst) AS day_total,
        ROW_NUMBER() OVER (PARTITION BY t.date_kst ORDER BY t.created_at, t.id) AS position
      FROM tweets t
      WHERE t.date_kst IN (${placeholders})
    )
    WHERE position <= 3
    ORDER BY date_kst, created_at, id
  `).bind(...dates).all<OnThisDayTweetRow>();
  return result.results;
}
