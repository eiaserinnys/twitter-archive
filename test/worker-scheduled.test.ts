import { describe, expect, it } from "vitest";
import { normalizeV2Response } from "../src/worker/collect/normalize-v2.js";
import { buildJevRequest, canReserveJevSpend } from "../src/worker/score-queue.js";
import type { NormalizedTweet } from "../src/shared/types.js";

const v2Response = {
  data: [
    {
      id: "101",
      author_id: "self",
      created_at: "2024-03-30T15:30:00.000Z",
      text: "short preview",
      note_tweet: { text: "Long &amp; complete https://t.co/link https://t.co/photo" },
      entities: {
        urls: [
          { url: "https://t.co/link", expanded_url: "https://example.test/article" },
          { url: "https://t.co/photo", expanded_url: "https://x.com/self/status/101/photo/1", media_key: "photo-key" },
        ],
      },
      attachments: { media_keys: ["photo-key", "video-key"] },
    },
    {
      id: "102",
      author_id: "self",
      created_at: "2024-03-30T14:00:00.000Z",
      text: "A reply",
      in_reply_to_user_id: "friend-id",
      referenced_tweets: [{ type: "replied_to", id: "900" }],
    },
    {
      id: "103",
      author_id: "self",
      created_at: "2024-03-30T13:00:00.000Z",
      text: "A self reply",
      in_reply_to_user_id: "self",
      referenced_tweets: [{ type: "replied_to", id: "101" }],
    },
    {
      id: "104",
      author_id: "self",
      created_at: "2024-03-30T12:00:00.000Z",
      text: "A quote",
      referenced_tweets: [{ type: "quoted", id: "800" }],
    },
  ],
  includes: {
    tweets: [
      { id: "900", author_id: "friend-id", text: "Parent &amp; body" },
      { id: "101", author_id: "self", text: "Long original" },
      { id: "800", author_id: "quoted-id", text: "Quoted body" },
    ],
    users: [
      { id: "friend-id", username: "friend" },
      { id: "self", username: "archive-owner" },
      { id: "quoted-id", username: "quoted-author" },
    ],
    media: [
      {
        media_key: "photo-key",
        type: "photo",
        url: "https://pbs.twimg.com/media/photo.jpg?format=jpg&name=large",
        width: 640,
        height: 480,
        alt_text: "Photo alt",
      },
      {
        media_key: "video-key",
        type: "video",
        preview_image_url: "https://pbs.twimg.com/media/video.jpg",
        width: 1280,
        height: 720,
        variants: [
          { content_type: "application/x-mpegURL", url: "https://video.test/video.m3u8" },
          { content_type: "video/mp4", bit_rate: 256000, url: "https://video.test/low.mp4" },
          { content_type: "video/mp4", bit_rate: 832000, url: "https://video.test/high.mp4" },
        ],
      },
    ],
  },
};

const scoreTweet: NormalizedTweet = {
  id: "10",
  created_at_utc: "2024-01-01T00:00:00.000Z",
  date_kst: "2024-01-01",
  year: 2024,
  month: 1,
  kind: "original",
  text: "A scored tweet",
  parent: null,
  quoted: null,
  lang: "en",
  source: "api",
  media: [],
};

describe("X API v2 collection normalization", () => {
  it("normalizes tweet kinds, included context, text, media and KST dates", () => {
    const rows = normalizeV2Response(v2Response, "self");

    expect(rows.map(({ tweet }) => [tweet.id, tweet.kind])).toEqual([
      ["101", "original"],
      ["102", "reply"],
      ["103", "self_reply"],
      ["104", "quote"],
    ]);
    expect(rows[0].tweet).toMatchObject({
      date_kst: "2024-03-31",
      text: "Long & complete https://example.test/article",
      source: "api",
      media: [
        { type: "photo", width: 640, height: 480, alt: "Photo alt", r2_key: null },
        { type: "video", width: 1280, height: 720, r2_key: null },
      ],
    });
    expect(rows[0].mediaUploads).toEqual([
      { url: "https://pbs.twimg.com/media/photo.jpg?format=jpg&name=large", contentType: "image/jpeg" },
      { url: "https://video.test/high.mp4", contentType: "video/mp4" },
    ]);
    expect(rows[1].tweet.parent).toEqual({ id: "900", text: "Parent & body", author: "friend" });
    expect(rows[2].tweet.parent).toEqual({ id: "101", text: "Long original", author: "archive-owner" });
    expect(rows[3].tweet.quoted).toEqual({ id: "800", text: "Quoted body" });
  });
});

describe("score queue requests and monthly cap", () => {
  it("asks only for topics missing their current score version", () => {
    const request = buildJevRequest(scoreTweet, [
      { id: "topic-a", question: "게임 개발" },
      { id: "topic-c", question: "일상 기록" },
    ]);

    expect(request.state).toBe("작성일: 2024-01-01\n종류: 원글\n트윗: A scored tweet");
    expect(request.questions).toEqual({
      "topic-a": { type: "noul", instructions: "이 트윗은 게임 개발에 관한 이야기인가?", criteria: { true: "그렇다", false: "아니다" } },
      "topic-c": { type: "noul", instructions: "이 트윗은 일상 기록에 관한 이야기인가?", criteria: { true: "그렇다", false: "아니다" } },
    });
  });

  it("stops reserving requests when the monthly cap is already reached", () => {
    expect(canReserveJevSpend(5, 0, 0.0001, 5)).toBe(false);
    expect(canReserveJevSpend(4.999, 0.0005, 0.001, 5)).toBe(false);
    expect(canReserveJevSpend(4.9, 0.05, 0.01, 5)).toBe(true);
  });
});
