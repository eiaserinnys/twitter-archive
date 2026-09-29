import type { MediaType, TweetKind } from "../shared/types.js";

export interface TweetDbRow {
  id: string;
  created_at: string;
  date_kst: string;
  kind: TweetKind;
  text: string;
  parent_id: string | null;
  parent_text: string | null;
  parent_author: string | null;
  quoted_id: string | null;
  quoted_text: string | null;
}

export interface MediaDbRow {
  type: MediaType;
  r2_key: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
}

export interface TweetTopicChip {
  id: string;
  score: number;
}

export interface TweetOut {
  id: string;
  created_at: string;
  date_kst: string;
  kind: TweetKind;
  text: string;
  parent: { id: string | null; text: string | null; author: string | null } | null;
  quoted: { id: string | null; text: string | null } | null;
  media: Array<{ type: MediaType; url: string | null; width: number | null; height: number | null; alt: string | null }>;
  topics: TweetTopicChip[];
  x_url: string;
}

export function serializeTweet(
  tweet: TweetDbRow,
  media: MediaDbRow[],
  topics: TweetTopicChip[],
): TweetOut {
  const hasParent = tweet.parent_id !== null || tweet.parent_text !== null || tweet.parent_author !== null;
  const hasQuote = tweet.quoted_id !== null || tweet.quoted_text !== null;
  return {
    id: tweet.id,
    created_at: new Date(tweet.created_at).toISOString(),
    date_kst: tweet.date_kst,
    kind: tweet.kind,
    text: tweet.text,
    parent: hasParent ? {
      id: tweet.parent_id,
      text: tweet.parent_text,
      author: tweet.parent_author,
    } : null,
    quoted: hasQuote ? { id: tweet.quoted_id, text: tweet.quoted_text } : null,
    media: media.map((item) => ({
      type: item.type,
      url: item.r2_key ? `/media/${item.r2_key}` : null,
      width: item.width,
      height: item.height,
      alt: item.alt,
    })),
    topics: topics.map(({ id, score }) => ({ id, score })),
    x_url: `https://x.com/i/status/${tweet.id}`,
  };
}
