import type { NormalizedTweet, TweetMedia } from "../../shared/types.js";
import type { D1PreparedStatement, Env } from "../env.js";
import { dataVersionStatement } from "../db/meta.js";
import { normalizeV2Response, type NormalizedV2Tweet } from "./normalize-v2.js";

const PAGE_LIMIT = 32;
const PAGE_SIZE = 100;
const WRITE_BATCH_TWEETS = 40;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function metaValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

async function collectionStartId(env: Env): Promise<string | null> {
  const collectSinceId = await metaValue(env, "collect_since_id");
  const maxTweetId = await metaValue(env, "max_tweet_id");
  if (collectSinceId === null) return maxTweetId;
  if (maxTweetId === null) return collectSinceId;
  return BigInt(collectSinceId) >= BigInt(maxTweetId) ? collectSinceId : maxTweetId;
}

function pageParameters(sinceId: string | null, paginationToken?: string): URLSearchParams {
  const params = new URLSearchParams({
    max_results: String(PAGE_SIZE),
    exclude: "retweets",
    "tweet.fields": "created_at,author_id,in_reply_to_user_id,referenced_tweets,attachments,entities,lang,note_tweet,article",
    expansions: "attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id",
    "media.fields": "type,url,preview_image_url,variants,width,height,alt_text",
    "user.fields": "username",
  });
  if (sinceId) params.set("since_id", sinceId);
  if (paginationToken) params.set("pagination_token", paginationToken);
  return params;
}

function latestId(tweets: NormalizedV2Tweet[]): string | null {
  return tweets.reduce<string | null>((latest, item) => {
    const id = item.tweet.id;
    return latest === null || BigInt(id) > BigInt(latest) ? id : latest;
  }, null);
}

function mediaExtension(media: TweetMedia, url: string): string {
  if (media.type !== "photo") return "mp4";
  const format = url.match(/[?&]format=([a-z0-9]+)/i)?.[1]?.toLowerCase();
  const extension = url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const name = format ?? extension ?? "jpg";
  return ["jpg", "jpeg", "png", "webp", "gif"].includes(name) ? name : "jpg";
}

async function uploadTweetMedia(env: Env, item: NormalizedV2Tweet, fetchImpl: typeof fetch): Promise<void> {
  for (let index = 0; index < item.tweet.media.length; index += 1) {
    const media = item.tweet.media[index];
    const upload = item.mediaUploads[index];
    if (!upload?.url) continue;
    const key = `media/${item.tweet.id}/${index + 1}.${mediaExtension(media, upload.url)}`;
    try {
      const response = await fetchImpl(upload.url);
      if (!response.ok) throw new Error(`Media HTTP ${response.status}`);
      const body = await response.arrayBuffer();
      await env.MEDIA.put(key, body, {
        httpMetadata: { contentType: upload.contentType ?? response.headers.get("content-type") ?? "application/octet-stream" },
      });
      media.r2_key = key;
    } catch (error) {
      console.error(`Could not store tweet media ${item.tweet.id}/${index + 1}.`, error);
    }
  }
}

function tweetStatement(db: Env["DB"], tweet: NormalizedTweet): D1PreparedStatement {
  return db.prepare(`
    INSERT OR REPLACE INTO tweets (
      id, created_at, date_kst, year, month, kind, text,
      article_title, article_text, parent_id, parent_text, parent_author, quoted_id, quoted_text, lang, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tweet.id,
    tweet.created_at_utc,
    tweet.date_kst,
    tweet.year,
    tweet.month,
    tweet.kind,
    tweet.text,
    tweet.article_title ?? null,
    tweet.article_text ?? null,
    tweet.parent?.id ?? null,
    tweet.parent?.text || null,
    tweet.parent?.author || null,
    tweet.quoted?.id ?? null,
    tweet.quoted?.text || null,
    tweet.lang,
    tweet.source,
  );
}

function mediaStatement(db: Env["DB"], tweet: NormalizedTweet): D1PreparedStatement | null {
  if (tweet.media.length === 0) return null;
  const values = tweet.media.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  return db.prepare(`INSERT OR REPLACE INTO media (tweet_id, idx, type, r2_key, width, height, alt) VALUES ${values}`)
    .bind(...tweet.media.flatMap((media, index) => [
      tweet.id,
      index,
      media.type,
      media.r2_key ?? null,
      media.width ?? null,
      media.height ?? null,
      media.alt ?? null,
    ]));
}

async function persistTweets(env: Env, tweets: NormalizedV2Tweet[]): Promise<void> {
  if (!env.DB.batch) throw new Error("D1 batch execution is unavailable.");
  for (let offset = 0; offset < tweets.length; offset += WRITE_BATCH_TWEETS) {
    const batch = tweets.slice(offset, offset + WRITE_BATCH_TWEETS);
    const statements = batch.flatMap(({ tweet }) => [tweetStatement(env.DB, tweet), mediaStatement(env.DB, tweet)]
      .filter((statement): statement is D1PreparedStatement => statement !== null));
    const results = await env.DB.batch(statements);
    if (results.some((result) => !result.success)) throw new Error("D1 rejected an X collection batch.");
  }
}

export async function collectNewTweets(env: Env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!env.X_USER_ID) throw new Error("X_USER_ID is required for scheduled collection.");
  if (!env.X_BEARER_TOKEN) throw new Error("X_BEARER_TOKEN is required for scheduled collection.");

  const sinceId = await collectionStartId(env);
  const tweets: NormalizedV2Tweet[] = [];
  let paginationToken: string | undefined;
  const pageLimit = PAGE_LIMIT;
  for (let page = 0; page < pageLimit; page += 1) {
    const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(env.X_USER_ID)}/tweets`);
    url.search = pageParameters(sinceId, paginationToken).toString();
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } });
    if (!response.ok) throw new Error(`X API HTTP ${response.status}`);
    const payload: unknown = await response.json();
    tweets.push(...normalizeV2Response(payload, env.X_USER_ID));
    const meta = payload && typeof payload === "object" && "meta" in payload ? (payload as { meta?: { next_token?: unknown } }).meta : undefined;
    paginationToken = stringValue(meta?.next_token);
    if (!paginationToken) break;
  }
  if (paginationToken && pageLimit === PAGE_LIMIT) {
    console.warn("X collection reached the 32-page timeline limit; re-import the X archive to fill older gaps.");
  }

  for (const item of tweets) await uploadTweetMedia(env, item, fetchImpl);
  await persistTweets(env, tweets);

  const collectedId = latestId(tweets) ?? sinceId;
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind("last_collected_at", now),
  ];
  if (collectedId) statements.push(env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind("collect_since_id", collectedId));
  if (tweets.length > 0) statements.push(dataVersionStatement(env.DB));
  if (!env.DB.batch) throw new Error("D1 batch execution is unavailable.");
  const results = await env.DB.batch(statements);
  if (results.some((result) => !result.success)) throw new Error("D1 rejected X collection metadata.");
  return tweets.map(({ tweet }) => tweet.id);
}
