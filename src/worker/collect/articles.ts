import { dataVersionStatement } from "../db/meta.js";
import type { Env } from "../env.js";
import { articleCoverUrl, uploadArticleCover } from "./media.js";

interface ArticleCandidate {
  id: string;
}

interface ArticleContent {
  title: string;
  text: string;
  coverUrl: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

export async function backfillArticles(env: Env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!env.X_BEARER_TOKEN) return [];

  const candidates = await env.DB.prepare(`
    SELECT id FROM tweets
    WHERE article_title IS NULL
    ORDER BY created_at, id
    LIMIT 100
  `).all<ArticleCandidate>();
  if (candidates.results.length === 0) return [];

  const url = new URL("https://api.x.com/2/tweets");
  url.searchParams.set("ids", candidates.results.map(({ id }) => id).join(","));
  url.searchParams.set("tweet.fields", "article");
  url.searchParams.set("expansions", "article.cover_media");
  url.searchParams.set("media.fields", "url,type,width,height");
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } });
  if (!response.ok) throw new Error(`X API HTTP ${response.status}`);

  const body = record(await response.json());
  const articleById = new Map<string, ArticleContent>();
  for (const tweet of records(body?.data)) {
    if (typeof tweet.id !== "string") continue;
    const article = record(tweet.article);
    if (!article) continue;
    articleById.set(tweet.id, {
      title: typeof article.title === "string" ? article.title : "",
      text: typeof article.plain_text === "string" ? article.plain_text : "",
      coverUrl: articleCoverUrl(article, record(body?.includes)?.media),
    });
  }

  const statements = [];
  for (const { id } of candidates.results) {
    const article = articleById.get(id);
    const coverKey = await uploadArticleCover(env, id, article?.coverUrl ?? null, fetchImpl);
    statements.push(env.DB.prepare(`
      UPDATE tweets SET article_title = ?, article_text = ?, article_cover_key = ? WHERE id = ?
    `).bind(article?.title ?? "", article?.text ?? "", coverKey, id));
  }
  statements.push(dataVersionStatement(env.DB));
  if (!env.DB.batch) throw new Error("D1 batch execution is unavailable.");
  const results = await env.DB.batch(statements);
  if (results.some((result) => !result.success)) throw new Error("D1 rejected an X article backfill batch.");

  return candidates.results.flatMap(({ id }) => articleById.has(id) ? [id] : []);
}
