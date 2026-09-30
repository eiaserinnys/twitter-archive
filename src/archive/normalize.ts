import type { NormalizedTweet, TweetContext, TweetKind, TweetMedia } from "../shared/types.js";
import { normalizeTweetText, tweetTextUrlEntities, type TweetUrlEntity } from "../shared/tweet-text.js";

interface RawTweet {
  [key: string]: unknown;
}

interface ArchiveAccount {
  id: string;
  username: string;
}

interface ArchiveNote {
  text: string;
  urls: TweetUrlEntity[];
}

function parseAssignment(content: Uint8Array): unknown[] {
  const source = new TextDecoder().decode(content);
  const equalsIndex = source.indexOf("=");
  const json = source.slice(equalsIndex + 1).trim().replace(/;\s*$/, "");
  return JSON.parse(json) as unknown[];
}

function recordValue(record: unknown, key: string): RawTweet | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const outer = record as Record<string, unknown>;
  const value = outer[key] ?? outer.tweet ?? outer;
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawTweet : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function archiveAccount(files: Map<string, Uint8Array>): ArchiveAccount {
  const accountFile = files.get("data/account.js");
  if (!accountFile) throw new Error("Archive is missing data/account.js.");
  const account = recordValue(parseAssignment(accountFile)[0], "account");
  const id = stringValue(account?.accountId) ?? stringValue(account?.id_str) ?? stringValue(account?.id);
  if (!id) throw new Error("Archive account id is missing.");
  return {
    id,
    username: stringValue(account?.username) ?? stringValue(account?.screen_name) ?? "",
  };
}

function noteTexts(files: Map<string, Uint8Array>): Map<string, ArchiveNote> {
  const noteFile = files.get("data/note-tweet.js");
  if (!noteFile) return new Map();
  const notes = new Map<string, ArchiveNote>();
  for (const record of parseAssignment(noteFile)) {
    const note = recordValue(record, "noteTweet") ?? recordValue(record, "note_tweet");
    const id = stringValue(note?.noteTweetId) ?? stringValue(note?.note_tweet_id) ?? stringValue(note?.id_str) ?? stringValue(note?.id);
    const contents = objectRecord(note?.noteTweetContents);
    const text = stringValue(contents?.text) ?? stringValue(note?.fullText) ?? stringValue(note?.full_text) ?? stringValue(note?.text);
    const entitySet = objectRecord(contents?.entitySet);
    const urls = Array.isArray(entitySet?.urls)
      ? entitySet.urls.flatMap((value) => {
        const entity = objectRecord(value);
        const url = stringValue(entity?.url);
        return url ? [{ url, expanded_url: stringValue(entity?.expanded_url) ?? stringValue(entity?.expandedUrl) }] : [];
      })
      : [];
    if (id && text) notes.set(id, { text, urls });
  }
  return notes;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function noteId(tweet: RawTweet): string | undefined {
  const note = tweet.note_tweet;
  if (typeof note === "string") return note;
  if (!note || typeof note !== "object" || Array.isArray(note)) return undefined;
  const value = note as Record<string, unknown>;
  return stringValue(value.note_tweet_id) ?? stringValue(value.noteTweetId) ?? stringValue(value.id_str);
}

function rawTweets(files: Map<string, Uint8Array>): RawTweet[] {
  const tweetPaths = [...files.keys()]
    .filter((path) => /^data\/tweets[^/]*\.js$/.test(path))
    .sort();
  if (tweetPaths.length === 0) throw new Error("Archive is missing data/tweets.js.");
  return tweetPaths.flatMap((path) => parseAssignment(files.get(path)!).map((record) => recordValue(record, "tweet") ?? {}));
}

function expandedUrls(tweet: RawTweet): TweetUrlEntity[] {
  const entities = tweet.entities;
  if (!entities || typeof entities !== "object") return [];
  const urls = (entities as Record<string, unknown>).urls;
  return Array.isArray(urls) ? urls as Array<{ url?: string; expanded_url?: string }> : [];
}

function mediaSource(tweet: RawTweet): Array<Record<string, unknown>> {
  const extended = tweet.extended_entities;
  if (!extended || typeof extended !== "object") return [];
  const media = (extended as Record<string, unknown>).media;
  return Array.isArray(media) ? media as Array<Record<string, unknown>> : [];
}

function linkedStatusId(tweet: RawTweet, text: string): string | undefined {
  const candidates = expandedUrls(tweet).map((url) => url.expanded_url ?? url.url ?? "");
  candidates.push(...(text.match(/https?:\/\/[^\s<>"']+/g) ?? []));
  let lastId: string | undefined;
  for (const url of candidates) {
    const match = url.match(/\/status\/(\d+)(?:[/?#]|$)/);
    if (match) lastId = match[1];
  }
  return lastId;
}

function normalizeText(tweet: RawTweet, expandedText: string, noteUrls?: TweetUrlEntity[]): string {
  const mediaUrls = new Set(mediaSource(tweet).map((media) => stringValue(media.url)).filter((url): url is string => Boolean(url)));
  const entities = tweet.entities;
  if (entities && typeof entities === "object") {
    const media = (entities as Record<string, unknown>).media;
    if (Array.isArray(media)) {
      for (const item of media) {
        if (item && typeof item === "object" && "url" in item) {
          const url = stringValue((item as Record<string, unknown>).url);
          if (url) mediaUrls.add(url);
        }
      }
    }
  }
  const textTweet = noteUrls === undefined
    ? tweet
    : { ...tweet, note_tweet: { text: expandedText, entities: { urls: noteUrls } } };
  return normalizeTweetText(expandedText, tweetTextUrlEntities(textTweet), mediaUrls);
}

function tweetKind(tweet: RawTweet, accountId: string, text: string): TweetKind {
  const replyId = stringValue(tweet.in_reply_to_status_id_str) ?? stringValue(tweet.in_reply_to_status_id);
  if (replyId) {
    const replyUser = stringValue(tweet.in_reply_to_user_id_str) ?? stringValue(tweet.in_reply_to_user_id);
    return replyUser === accountId ? "self_reply" : "reply";
  }
  return linkedStatusId(tweet, text) ? "quote" : "original";
}

function mediaRows(tweet: RawTweet, id: string): TweetMedia[] {
  return mediaSource(tweet).map((media) => {
    const type = media.type === "animated_gif" ? "animated_gif" : media.type === "video" ? "video" : "photo";
    const mediaUrl = stringValue(media.media_url_https) ?? stringValue(media.media_url) ?? "";
    const filename = mediaUrl.split("?")[0].split("/").pop() ?? "media";
    const sizes = media.sizes && typeof media.sizes === "object" ? media.sizes as Record<string, unknown> : {};
    const large = sizes.large && typeof sizes.large === "object" ? sizes.large as Record<string, unknown> : {};
    const width = typeof large.w === "number" ? large.w : undefined;
    const height = typeof large.h === "number" ? large.h : undefined;
    return {
      type,
      archive_path: `data/tweets_media/${id}-${filename}`,
      r2_key: null,
      width,
      height,
      alt: stringValue(media.ext_alt_text) ?? stringValue(media.alt_text),
    };
  });
}

function createdAtFields(value: unknown): Pick<NormalizedTweet, "created_at_utc" | "date_kst" | "year" | "month"> {
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error("Archive tweet has an invalid created_at value.");
  const createdAt = new Date(timestamp).toISOString();
  const kst = new Date(timestamp + 9 * 60 * 60 * 1000);
  const dateKst = kst.toISOString().slice(0, 10);
  return {
    created_at_utc: createdAt,
    date_kst: dateKst,
    year: Number(dateKst.slice(0, 4)),
    month: Number(dateKst.slice(5, 7)),
  };
}

export function normalizeArchive(files: Map<string, Uint8Array>): NormalizedTweet[] {
  const account = archiveAccount(files);
  const notes = noteTexts(files);
  const records = rawTweets(files).filter((tweet) => !String(tweet.full_text ?? "").startsWith("RT @"));
  const textById = new Map<string, string>();
  const tweetTexts = records.map((tweet) => {
    const id = stringValue(tweet.id_str) ?? stringValue(tweet.id);
    if (!id) throw new Error("Archive tweet id is missing.");
    const archiveText = stringValue(tweet.full_text) ?? stringValue(tweet.text) ?? "";
    const note = notes.get(noteId(tweet) ?? id);
    const expandedText = note?.text ?? archiveText;
    const text = normalizeText(tweet, expandedText, note?.urls);
    textById.set(id, text);
    return { tweet, id, text };
  });

  return tweetTexts.map(({ tweet, id, text }) => {
    const replyId = stringValue(tweet.in_reply_to_status_id_str) ?? stringValue(tweet.in_reply_to_status_id);
    const kind = tweetKind(tweet, account.id, text);
    const quoteId = kind === "quote" ? linkedStatusId(tweet, text) : undefined;
    const parentAuthor = stringValue(tweet.in_reply_to_screen_name) ?? (kind === "self_reply" ? account.username : "");
    const parent: TweetContext | null = replyId
      ? { id: replyId, text: kind === "self_reply" ? (textById.get(replyId) ?? "") : "", author: parentAuthor }
      : null;
    const quoted: TweetContext | null = quoteId
      ? { id: quoteId, text: textById.get(quoteId) ?? "" }
      : null;
    const metrics: Record<string, number> = {};
    const metricFields: Array<[string, string]> = [
      ["retweet_count", "retweet_count"],
      ["favorite_count", "like_count"],
      ["quote_count", "quote_count"],
      ["reply_count", "reply_count"],
      ["bookmark_count", "bookmark_count"],
      ["impression_count", "impression_count"],
    ];
    for (const [source, target] of metricFields) if (typeof tweet[source] === "number") metrics[target] = tweet[source] as number;
    return {
      id,
      ...createdAtFields(tweet.created_at),
      kind,
      text,
      parent,
      quoted,
      lang: stringValue(tweet.lang) ?? null,
      source: "archive",
      media: mediaRows(tweet, id),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    };
  });
}
