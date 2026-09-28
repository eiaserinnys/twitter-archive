export type TweetKind = "original" | "reply" | "self_reply" | "quote";
export type MediaType = "photo" | "video" | "animated_gif";

export interface TweetContext {
  id: string;
  text: string;
  author?: string;
}

export interface TweetMedia {
  type: MediaType;
  archive_path?: string;
  r2_key?: string | null;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
}

export interface NormalizedTweet {
  id: string;
  created_at_utc: string;
  date_kst: string;
  year: number;
  month: number;
  kind: TweetKind;
  text: string;
  parent: TweetContext | null;
  quoted: TweetContext | null;
  lang: string | null;
  source: "archive" | "api";
  media: TweetMedia[];
  metrics?: Record<string, number>;
}
