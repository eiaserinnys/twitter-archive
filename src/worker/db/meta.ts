import type { D1Database } from "../env.js";

export interface CacheMeta {
  data_version: string | null;
  last_collected_at: string | null;
}

export async function getCacheMeta(db: D1Database): Promise<CacheMeta> {
  const result = await db.prepare(`
    SELECT key, value FROM meta
    WHERE key IN ('data_version', 'last_collected_at')
  `).all<{ key: string; value: string }>();
  const values = new Map(result.results.map(({ key, value }) => [key, value]));
  return {
    data_version: values.get("data_version") ?? null,
    last_collected_at: values.get("last_collected_at") ?? null,
  };
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

export async function getTweetStats(db: D1Database): Promise<TweetStats> {
  const result = await db.prepare(`
    SELECT COUNT(*) AS total_tweets, MIN(date_kst) AS first_date, MAX(date_kst) AS last_date
    FROM tweets
  `).first<TweetStats>();
  return result ?? { total_tweets: 0, first_date: null, last_date: null };
}
