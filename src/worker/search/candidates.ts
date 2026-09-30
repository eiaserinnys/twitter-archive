import { TOPIC_SEED } from "../../shared/topics.js";
import type { Viewer } from "../auth.js";
import type { D1Database } from "../env.js";
import type { TweetDbRow } from "../serialize.js";
import { publicHiddenSql } from "../visibility.js";
import type { SearchPeriod, SearchStrategyId } from "./judge.js";

export interface CandidateFilters {
  q: string;
  strategies: readonly SearchStrategyId[];
  topicCoordinates: Array<{ id: string; score: number }>;
  period?: SearchPeriod | null;
  topics?: string[];
  kinds?: string[];
  from?: string;
  to?: string;
  excludeIds?: string[];
}

export async function findCandidates(db: D1Database, viewer: Viewer, filters: CandidateFilters): Promise<TweetDbRow[]> {
  const words = filters.q.split(/\s+/).filter((word) => word.length >= 2);
  const wordSql = words.length > 0
    ? words.map(() => `(instr(lower(t.text || ' ' || COALESCE(t.parent_text, '') || ' ' || COALESCE(t.quoted_text, '') || ' ' || COALESCE(t.article_title, '') || ' ' || COALESCE(t.article_text, '')), lower(?)) > 0)`).join(" OR ")
    : "0";
  const wordValues = words;
  const coordinates = filters.topicCoordinates;
  const topicSql = coordinates.length > 0 ? `(
    SELECT COALESCE(SUM(s.score * CASE s.topic ${coordinates.map(() => "WHEN ? THEN ?").join(" ")} ELSE 0 END), 0)
    FROM scores s
    JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
    WHERE s.tweet_id = t.id
  )` : "0";
  const values: unknown[] = [...wordValues, ...coordinates.flatMap(({ id, score }) => [id, score])];
  const clauses: string[] = [];
  if (filters.from) { clauses.push("t.date_kst >= ?"); values.push(filters.from); }
  if (filters.to) { clauses.push("t.date_kst <= ?"); values.push(filters.to); }
  if (filters.strategies.includes("period") && filters.period) {
    clauses.push("t.date_kst >= ?", "t.date_kst <= ?");
    values.push(filters.period.from, filters.period.to);
  }
  if (filters.kinds?.length) {
    clauses.push(`t.kind IN (${filters.kinds.map(() => "?").join(", ")})`);
    values.push(...filters.kinds);
  }
  if (filters.topics?.length) {
    clauses.push(`EXISTS (
      SELECT 1 FROM scores s
      JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
      WHERE s.tweet_id = t.id AND s.topic IN (${filters.topics.map(() => "?").join(", ")})
        AND s.score >= ?
    )`);
    values.push(...filters.topics, TOPIC_SEED.search_threshold);
  }
  if (filters.excludeIds?.length) {
    clauses.push(`t.id NOT IN (${filters.excludeIds.map(() => "?").join(", ")})`);
    values.push(...filters.excludeIds);
  }
  clauses.push(`NOT EXISTS (
    SELECT 1 FROM scores s
    JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
    WHERE s.tweet_id = t.id AND s.score >= ? AND ${viewer.viewingAs === "owner"
    ? "tp.search_visibility = 'hidden'" : "tp.search_visibility != 'public'"}
  )`);
  if (viewer.viewingAs === "visitor") clauses.push(`NOT ${publicHiddenSql("t")}`);
  values.push(TOPIC_SEED.display_threshold);
  const match = [filters.strategies.includes("words") && words.length > 0 ? "word_match = 1" : "",
    filters.strategies.includes("topics") && coordinates.length > 0 ? "topic_score > 0" : ""].filter(Boolean).join(" OR ");
  const ownerFields = viewer.viewingAs === "owner"
    ? `, t.visibility, CASE WHEN ${publicHiddenSql("t")} THEN 1 ELSE 0 END AS public_hidden`
    : "";
  const ownerOutput = viewer.viewingAs === "owner" ? ", visibility, public_hidden" : "";
  const result = await db.prepare(`
    WITH matched AS (
      SELECT t.id, t.created_at, t.date_kst, t.kind, t.text, t.article_title, t.article_text, t.article_cover_key, t.parent_id, t.parent_text,
        t.parent_author, t.quoted_id, t.quoted_text${ownerFields},
        CASE WHEN ${wordSql} THEN 1 ELSE 0 END AS word_match,
        ${topicSql} AS topic_score
      FROM tweets t
      WHERE ${clauses.join(" AND ")}
    )
    SELECT id, created_at, date_kst, kind, text, parent_id, parent_text, parent_author,
      quoted_id, quoted_text, article_title, article_text, article_cover_key${ownerOutput}
    FROM matched
    ${match ? `WHERE ${match}` : filters.strategies.includes("period") ? "" : "WHERE 0"}
    ORDER BY word_match DESC, topic_score DESC, created_at DESC, id DESC
    LIMIT 480
  `).bind(...values).all<TweetDbRow>();
  return result.results;
}
