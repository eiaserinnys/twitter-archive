import type { NormalizedTweet, TweetContext, TweetKind, TweetMedia, MediaType } from "../../shared/types.js";
import { normalizeTweetText, type TweetUrlEntity } from "../../shared/tweet-text.js";

interface RawRecord {
  [key: string]: unknown;
}

interface MediaUpload {
  url: string | null;
  contentType: string | null;
}

export interface NormalizedV2Tweet {
  tweet: NormalizedTweet;
  mediaUploads: MediaUpload[];
}

function record(value: unknown): RawRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : undefined;
}

function records(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is RawRecord => Boolean(item)) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function urlEntities(tweet: RawRecord): Array<TweetUrlEntity & { media_key?: string; expanded_url?: string }> {
  return records(record(tweet.entities)?.urls) as Array<TweetUrlEntity & { media_key?: string; expanded_url?: string }>;
}

function includedText(tweet: RawRecord): string {
  const noteTweet = record(tweet.note_tweet);
  const text = stringValue(noteTweet?.text) ?? stringValue(tweet.text) ?? "";
  const urls = urlEntities(tweet);
  const mediaUrls = new Set(urls.filter((url) => url.media_key).map((url) => url.url).filter((url): url is string => Boolean(url)));
  return normalizeTweetText(text, urls, mediaUrls);
}

function mediaType(value: unknown): MediaType {
  if (value === "video") return "video";
  if (value === "animated_gif") return "animated_gif";
  return "photo";
}

function photoContentType(url: string): string {
  const format = url.match(/[?&]format=([a-z0-9]+)/i)?.[1]?.toLowerCase();
  const extension = url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const name = format ?? extension ?? "jpg";
  if (name === "png") return "image/png";
  if (name === "webp") return "image/webp";
  if (name === "gif") return "image/gif";
  return "image/jpeg";
}

function uploadFor(media: RawRecord, type: MediaType): MediaUpload {
  if (type === "photo") {
    const url = stringValue(media.url) ?? null;
    return { url, contentType: url ? photoContentType(url) : null };
  }
  const variant = records(media.variants)
    .filter((item) => item.content_type === "video/mp4" && stringValue(item.url))
    .sort((left, right) => Number(left.bit_rate ?? 0) - Number(right.bit_rate ?? 0))
    .at(-1);
  return variant ? { url: stringValue(variant.url) ?? null, contentType: "video/mp4" } : { url: null, contentType: null };
}

function createdAtFields(value: unknown): Pick<NormalizedTweet, "created_at_utc" | "date_kst" | "year" | "month"> {
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error("X API tweet has an invalid created_at value.");
  const createdAt = new Date(timestamp).toISOString();
  const dateKst = new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    created_at_utc: createdAt,
    date_kst: dateKst,
    year: Number(dateKst.slice(0, 4)),
    month: Number(dateKst.slice(5, 7)),
  };
}

function reference(tweet: RawRecord, type: string): RawRecord | undefined {
  return records(tweet.referenced_tweets).find((item) => item.type === type);
}

function contextFromIncluded(
  id: string | undefined,
  tweetById: Map<string, RawRecord>,
  usernameById: Map<string, string>,
  includeAuthor = true,
): TweetContext | null {
  if (!id) return null;
  const included = tweetById.get(id);
  const authorId = stringValue(included?.author_id);
  const author = includeAuthor && authorId ? usernameById.get(authorId) : undefined;
  return {
    id,
    text: included ? includedText(included) : "",
    ...(author ? { author } : {}),
  };
}

function normalizeTweet(
  tweet: RawRecord,
  userId: string,
  tweetById: Map<string, RawRecord>,
  usernameById: Map<string, string>,
  mediaByKey: Map<string, RawRecord>,
): NormalizedV2Tweet {
  const id = stringValue(tweet.id);
  if (!id) throw new Error("X API tweet id is missing.");
  const replyUserId = stringValue(tweet.in_reply_to_user_id);
  const repliedTo = reference(tweet, "replied_to");
  const quotedRef = reference(tweet, "quoted");
  const kind: TweetKind = replyUserId
    ? (replyUserId === userId ? "self_reply" : "reply")
    : (quotedRef ? "quote" : "original");
  const mediaKeys = Array.isArray(record(tweet.attachments)?.media_keys)
    ? (record(tweet.attachments)?.media_keys as unknown[]).filter((key): key is string => typeof key === "string")
    : [];
  const mediaItems = mediaKeys.map((key) => mediaByKey.get(key)).filter((item): item is RawRecord => Boolean(item));
  const urls = urlEntities(tweet);
  const mediaUrls = new Set<string>();
  for (const url of urls) {
    if (url.url && (url.media_key || /\/(?:photo|video)\/\d+(?:[/?#]|$)/i.test(url.expanded_url ?? ""))) mediaUrls.add(url.url);
  }
  for (const media of mediaItems) {
    const mediaUrl = stringValue(media.url) ?? stringValue(media.preview_image_url);
    if (mediaUrl) mediaUrls.add(mediaUrl);
  }
  const noteTweet = record(tweet.note_tweet);
  const text = normalizeTweetText(stringValue(noteTweet?.text) ?? stringValue(tweet.text) ?? "", urls, mediaUrls);
  const media: TweetMedia[] = mediaItems.map((item) => ({
    type: mediaType(item.type),
    r2_key: null,
    width: typeof item.width === "number" ? item.width : null,
    height: typeof item.height === "number" ? item.height : null,
    alt: stringValue(item.alt_text) ?? null,
  }));
  const parent = replyUserId ? contextFromIncluded(stringValue(repliedTo?.id), tweetById, usernameById) : null;
  const quoted = kind === "quote" ? contextFromIncluded(stringValue(quotedRef?.id), tweetById, usernameById, false) : null;
  return {
    tweet: {
      id,
      ...createdAtFields(tweet.created_at),
      kind,
      text,
      parent,
      quoted,
      lang: stringValue(tweet.lang) ?? null,
      source: "api",
      media,
    },
    mediaUploads: mediaItems.map((item) => uploadFor(item, mediaType(item.type))),
  };
}

export function normalizeV2Response(response: unknown, userId: string): NormalizedV2Tweet[] {
  const body = record(response);
  if (!body) throw new Error("X API response is not an object.");
  if (body.data === undefined) return [];
  if (!Array.isArray(body.data)) throw new Error("X API response data is not an array.");
  const includes = record(body.includes);
  const tweetById = new Map(records(includes?.tweets).flatMap((tweet) => {
    const id = stringValue(tweet.id);
    return id ? [[id, tweet] as const] : [];
  }));
  const usernameById = new Map(records(includes?.users).flatMap((user) => {
    const id = stringValue(user.id);
    const username = stringValue(user.username);
    return id && username ? [[id, username] as const] : [];
  }));
  const mediaByKey = new Map(records(includes?.media).flatMap((media) => {
    const key = stringValue(media.media_key);
    return key ? [[key, media] as const] : [];
  }));
  return records(body.data).map((tweet) => normalizeTweet(tweet, userId, tweetById, usernameById, mediaByKey));
}
