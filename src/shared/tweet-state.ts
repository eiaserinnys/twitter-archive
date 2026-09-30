import type { NormalizedTweet } from "./types.js";

const KIND_LABELS: Record<NormalizedTweet["kind"], string> = {
  original: "원글",
  reply: "답글",
  self_reply: "자기 트윗에 이어 단 답글",
  quote: "인용",
};

const MEDIA_LABELS: Record<string, string> = {
  photo: "사진",
  video: "영상",
  animated_gif: "움짤",
};

export const ARTICLE_TEXT_LIMIT = 3_000;

export function tweetTextForJev(tweet: Pick<NormalizedTweet, "text" | "article_title" | "article_text">): string {
  if (!tweet.article_title) return tweet.text;
  return [
    tweet.text,
    `아티클 제목: ${tweet.article_title}`,
    `아티클 본문: ${(tweet.article_text ?? "").slice(0, ARTICLE_TEXT_LIMIT)}`,
  ].join("\n");
}

export function buildState(tweet: NormalizedTweet): string {
  const lines = [`작성일: ${tweet.date_kst}`, `종류: ${KIND_LABELS[tweet.kind]}`];
  if (tweet.parent?.text) lines.push(`원글: ${tweet.parent.text}`);
  if (tweet.quoted?.text) lines.push(`인용한 글: ${tweet.quoted.text}`);
  lines.push(`트윗: ${tweetTextForJev(tweet)}`);
  const counts = new Map<string, number>();
  for (const media of tweet.media ?? []) {
    const label = MEDIA_LABELS[media.type] ?? "미디어";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size > 0) lines.push(`첨부: ${[...counts].map(([label, count]) => `${label} ${count}개`).join(", ")}`);
  return lines.join("\n");
}
