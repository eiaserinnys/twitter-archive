import { TOPIC_SEED } from "../shared/topics.js";
import type { D1Database } from "./env.js";
import { publicHiddenSql } from "./visibility.js";

export const OTHER_TOPIC_ID = "other";

export function otherTopic() {
  return {
    id: OTHER_TOPIC_ID,
    label: "기타",
    question: "",
    builtin: true,
    active: 1,
    version: "builtin",
    timeline_visibility: "public" as const,
    search_visibility: "hidden" as const,
    public_hide_threshold: null,
    sort_order: Number.MAX_SAFE_INTEGER,
  };
}

export async function isOtherTopicEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'other_topic'")
    .first<{ value: string }>();
  return row?.value === "1";
}

function assignedScoreSql(): string {
  return `tp.active = 1 AND s.version = tp.version AND s.score >= ${TOPIC_SEED.display_threshold}`;
}

// A: build the qualifying set once for year/month aggregates using the score index.
export function assignedTweetIdsSql(): string {
  return `SELECT s.tweet_id FROM topics tp CROSS JOIN scores s INDEXED BY scores_topic
    WHERE s.topic = tp.id AND ${assignedScoreSql()}`;
}

// B: use the tweet/topic primary key for calendar days and limited tweet pages.
// Both shapes exclude public-hidden tweets for owners as well as visitors.
export function otherTweetSql(alias: string, assignedSet?: string): string {
  const unassigned = assignedSet
    ? `${alias}.id NOT IN (SELECT tweet_id FROM ${assignedSet})`
    : `NOT EXISTS (
      SELECT 1 FROM scores s JOIN topics tp ON tp.id = s.topic
      WHERE s.tweet_id = ${alias}.id AND ${assignedScoreSql()}
    )`;
  return `(NOT ${publicHiddenSql(alias)} AND ${unassigned})`;
}

export interface OtherCountRow {
  period: number | string;
  other_count: number;
}

export async function getOtherCounts(
  db: D1Database,
  period: "year" | "month" | "date_kst",
  year?: number,
  month?: number,
): Promise<OtherCountRow[]> {
  const aggregateSet = period !== "date_kst";
  const scope = [year === undefined ? "" : "t.year = ?", month === undefined ? "" : "t.month = ?"]
    .filter(Boolean);
  const values = [year, month].filter(value => value !== undefined);
  const result = await db.prepare(`
    ${aggregateSet ? `WITH assigned AS MATERIALIZED (${assignedTweetIdsSql()})` : ""}
    SELECT t.${period} AS period, COUNT(*) AS other_count
    FROM tweets t
    WHERE ${[...scope, otherTweetSql("t", aggregateSet ? "assigned" : undefined)].join(" AND ")}
    GROUP BY t.${period}
  `).bind(...values).all<OtherCountRow>();
  return result.results;
}
