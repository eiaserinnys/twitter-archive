import type { Viewer } from "../auth.js";
import type { D1Database } from "../env.js";
import { TOPIC_SEED } from "../../shared/topics.js";
import { publicHiddenSql, type TimelineCountRow } from "../visibility.js";

function visibleTopicClause(viewer: Viewer): string {
  return viewer.viewingAs === "owner"
    ? "tp.timeline_visibility IN ('public', 'owner')"
    : "tp.timeline_visibility = 'public'";
}

export async function getTimelineCounts(db: D1Database, viewer: Viewer): Promise<TimelineCountRow[]> {
  const result = await db.prepare(`
    SELECT t.year, COUNT(DISTINCT t.id) AS total, tp.id AS topic_id,
      COUNT(DISTINCT CASE WHEN tp.id IS NOT NULL THEN t.id END) AS topic_count
    FROM tweets t
    LEFT JOIN scores s ON s.tweet_id = t.id
    LEFT JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
      AND s.score >= ? AND ${visibleTopicClause(viewer)}
    WHERE ${viewer.viewingAs === "visitor" ? `NOT ${publicHiddenSql("t")}` : "1 = 1"}
    GROUP BY t.year, tp.id
    ORDER BY t.year, tp.sort_order, tp.id
  `).bind(TOPIC_SEED.display_threshold).all<TimelineCountRow>();
  return result.results;
}

export interface MonthCountRow {
  month: number;
  total: number;
  topic_id: string | null;
  topic_count: number;
}

export async function getMonthCounts(db: D1Database, year: number, viewer: Viewer): Promise<MonthCountRow[]> {
  const result = await db.prepare(`
    SELECT t.month, COUNT(DISTINCT t.id) AS total, tp.id AS topic_id,
      COUNT(DISTINCT CASE WHEN tp.id IS NOT NULL THEN t.id END) AS topic_count
    FROM tweets t
    LEFT JOIN scores s ON s.tweet_id = t.id
    LEFT JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
      AND s.score >= ? AND ${visibleTopicClause(viewer)}
    WHERE t.year = ? AND ${viewer.viewingAs === "visitor" ? `NOT ${publicHiddenSql("t")}` : "1 = 1"}
    GROUP BY t.month, tp.id
    ORDER BY t.month, tp.sort_order, tp.id
  `).bind(TOPIC_SEED.display_threshold, year).all<MonthCountRow>();
  return result.results;
}

export interface CalendarCountRow {
  date: string;
  total: number;
  topic_id: string | null;
  score_sum: number | null;
  sort_order: number | null;
}

export async function getCalendarCounts(
  db: D1Database,
  year: number,
  month: number,
  viewer: Viewer,
): Promise<CalendarCountRow[]> {
  const result = await db.prepare(`
    SELECT t.date_kst AS date, COUNT(DISTINCT t.id) AS total, tp.id AS topic_id,
      SUM(CASE WHEN tp.id IS NOT NULL THEN s.score ELSE 0 END) AS score_sum,
      tp.sort_order
    FROM tweets t
    LEFT JOIN scores s ON s.tweet_id = t.id
    LEFT JOIN topics tp ON tp.id = s.topic AND tp.active = 1 AND tp.version = s.version
      AND s.score >= ? AND ${visibleTopicClause(viewer)}
    WHERE t.year = ? AND t.month = ? AND ${viewer.viewingAs === "visitor" ? `NOT ${publicHiddenSql("t")}` : "1 = 1"}
    GROUP BY t.date_kst, tp.id
    ORDER BY t.date_kst, score_sum DESC, tp.sort_order, tp.id
  `).bind(TOPIC_SEED.display_threshold, year, month).all<CalendarCountRow>();
  return result.results;
}

export async function getDatesForOnThisDay(db: D1Database, viewer: Viewer): Promise<Array<{ year: number; date: string }>> {
  const result = await db.prepare(`
    SELECT t.year, t.date_kst AS date
    FROM tweets t
    WHERE ${viewer.viewingAs === "visitor" ? `NOT ${publicHiddenSql("t")}` : "1 = 1"}
    GROUP BY t.year, t.date_kst
    ORDER BY t.year, t.date_kst
  `).all<{ year: number; date: string }>();
  return result.results;
}
