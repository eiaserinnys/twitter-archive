import type { D1Database } from "../env.js";

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

export async function getLastCollectedAt(db: D1Database): Promise<string | null> {
  const result = await db.prepare(`
    SELECT value FROM meta
    WHERE key IN ('last_collected_at', 'last_import_at')
    ORDER BY CASE key WHEN 'last_collected_at' THEN 0 ELSE 1 END
    LIMIT 1
  `).first<{ value: string }>();
  return result?.value ?? null;
}
