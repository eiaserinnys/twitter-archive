import { describe, expect, it, vi } from "vitest";
import { normalizeV2Response } from "../src/worker/collect/normalize-v2.js";
import { collectNewTweets } from "../src/worker/collect/index.js";
import { buildJevRequest, canReserveJevSpend } from "../src/worker/score-queue.js";
import type { Env } from "../src/worker/env.js";
import type { NormalizedTweet } from "../src/shared/types.js";

const v2Response = {
  data: [
    {
      id: "101",
      author_id: "self",
      created_at: "2024-03-30T15:30:00.000Z",
      text: "short preview",
      article: { title: "Synthetic article title", plain_text: "Synthetic article body from the API response." },
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
      article_title: "Synthetic article title",
      article_text: "Synthetic article body from the API response.",
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

describe("initial X collection", () => {
  it("follows multiple pages when no cursor exists", async () => {
    const statement = {
      bind() { return statement; },
      all: async () => ({ results: [], success: true, meta: { changes: 0 } }),
      first: async () => null,
      run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
    };
    const db = {
      prepare: () => statement,
      batch: async () => [],
    };
    const env = { DB: db, X_USER_ID: "self", X_BEARER_TOKEN: "test-token" } as unknown as Env;
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      const page = requests.length;
      return Response.json({
        data: [{
          id: String(1000 + page),
          author_id: "self",
          created_at: "2024-01-01T00:00:00.000Z",
          text: `Synthetic initial post ${page}`,
        }],
        meta: page < 3 ? { next_token: `page-${page}` } : {},
      });
    };

    const ids = await collectNewTweets(env, fetchImpl);

    expect(requests).toHaveLength(3);
    expect(requests[0].searchParams.get("max_results")).toBe("100");
    expect(requests[0].searchParams.get("tweet.fields")?.split(",")).toContain("article");
    expect(requests[0].searchParams.has("since_id")).toBe(false);
    expect(requests.map((url) => url.searchParams.get("pagination_token"))).toEqual([null, "page-1", "page-2"]);
    expect(ids).toEqual(["1001", "1002", "1003"]);
  });
});

describe("paged X collection", () => {
  it("stops after 32 pages and warns when a next token remains", async () => {
    const statement = {
      key: "",
      bind(key: string) { statement.key = key; return statement; },
      all: async () => ({ results: [], success: true, meta: { changes: 0 } }),
      first: async () => statement.key === "collect_since_id" ? { value: "999" } : null,
      run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
    };
    const db = {
      prepare: () => statement,
      batch: async () => [],
    };
    const env = { DB: db, X_USER_ID: "self", X_BEARER_TOKEN: "test-token" } as unknown as Env;
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      const page = requests.length;
      return Response.json({
        data: [{
          id: String(1000 + page),
          author_id: "self",
          created_at: "2024-01-01T00:00:00.000Z",
          text: `Synthetic post ${page}`,
        }],
        meta: { next_token: `page-${page}` },
      });
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await collectNewTweets(env, fetchImpl);

      expect(requests).toHaveLength(32);
      expect(requests[0].searchParams.has("pagination_token")).toBe(false);
      expect(requests[1].searchParams.get("pagination_token")).toBe("page-1");
      expect(requests[31].searchParams.get("pagination_token")).toBe("page-31");
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "X collection reached the 32-page timeline limit; re-import the X archive to fill older gaps.",
      );
    } finally {
      warning.mockRestore();
    }
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

  it("adds article title and only the first 3,000 body characters to scoring state", () => {
    const request = buildJevRequest({
      ...scoreTweet,
      article_title: "Synthetic long article",
      article_text: "x".repeat(3_005),
    }, [{ id: "topic-a", question: "게임 개발" }]);

    expect(request.state).toBe([
      "작성일: 2024-01-01",
      "종류: 원글",
      "트윗: A scored tweet",
      "아티클 제목: Synthetic long article",
      `아티클 본문: ${"x".repeat(3_000)}`,
    ].join("\n"));
  });
});
