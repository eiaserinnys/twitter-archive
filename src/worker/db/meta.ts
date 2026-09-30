import type { D1Database } from "../env.js";
import type { Viewer } from "../auth.js";
import { publicHiddenSql, replyScopeSql, type Visibility } from "../visibility.js";

export interface CacheMeta {
  data_version: string | null;
  last_collected_at: string | null;
  reply_visibility: Visibility;
}

export async function getCacheMeta(db: D1Database): Promise<CacheMeta> {
  const result = await db.prepare(`
    SELECT key, value FROM meta
    WHERE key IN ('data_version', 'last_collected_at', 'last_import_at', 'reply_visibility')
  `).all<{ key: string; value: string }>();
  const values = new Map(result.results.map(({ key, value }) => [key, value]));
  return {
    reply_visibility: (values.get("reply_visibility") ?? "hidden") as Visibility,
    data_version: values.get("data_version") ?? null,
    last_collected_at: values.get("last_collected_at") ?? values.get("last_import_at") ?? null,
  };
}

export async function getReplyVisibility(db: D1Database): Promise<Visibility> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'reply_visibility'")
    .first<{ value: Visibility }>();
  return row?.value ?? "hidden";
}

export async function getDataVersion(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'data_version'")
    .first<{ value: string }>();
  return row?.value ?? null;
}

export function dataVersionStatement(db: D1Database) {
  return db.prepare(`
    INSERT INTO meta (key, value) VALUES ('data_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(String(Date.now()));
}

export async function bumpDataVersion(db: D1Database): Promise<void> {
  await dataVersionStatement(db).run();
}

export interface TweetStats {
  total_tweets: number;
  first_date: string | null;
  last_date: string | null;
}

export async function getTweetStats(db: D1Database, viewer: Viewer, replyVisibility?: Visibility): Promise<TweetStats> {
  const replies = replyVisibility ?? await getReplyVisibility(db);
  const result = await db.prepare(`
    SELECT COUNT(*) AS total_tweets, MIN(date_kst) AS first_date, MAX(date_kst) AS last_date
    FROM tweets t
    WHERE ${replyScopeSql("t", viewer, replies)} AND ${viewer.viewingAs === "visitor" ? `NOT ${publicHiddenSql("t")}` : "1 = 1"}
  `).first<TweetStats>();
  return result ?? { total_tweets: 0, first_date: null, last_date: null };
}

export async function getPublicHiddenCount(db: D1Database): Promise<number> {
  const result = await db.prepare(`SELECT COUNT(*) AS count FROM tweets t WHERE ${publicHiddenSql("t")}`)
    .first<{ count: number }>();
  return result?.count ?? 0;
}
