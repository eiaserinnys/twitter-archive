import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { app } from "../src/worker/index.js";
import type { Env } from "../src/worker/env.js";
import { getViewer } from "../src/worker/auth.js";
import {
  filterVisibleTags,
  isTopicFilterAllowed,
  selectTweetTopicChips,
  shapeTimelineRows,
} from "../src/worker/visibility.js";
import { decodeCursor, encodeCursor } from "../src/worker/cursor.js";
import { serializeTweet } from "../src/worker/serialize.js";

const authEnv = {
  ACCESS_TEAM_DOMAIN: "unit-test.cloudflareaccess.com",
  ACCESS_AUD: "archive-app,archive-preview",
  OWNER_EMAILS: "owner@example.test",
  OWNER_SERVICE_TOKEN_IDS: "service-client-7",
};

describe("Access viewer", () => {
  let privateKey: CryptoKey;
  let jwksResponse: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwksResponse = JSON.stringify({ keys: [{ ...publicJwk, kid: "unit-key", alg: "RS256", use: "sig" }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(jwksResponse, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
  });

  afterAll(() => vi.unstubAllGlobals());

  async function token(payload: Record<string, unknown>, audience = "archive-app"): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "unit-key" })
      .setIssuer(`https://${authEnv.ACCESS_TEAM_DOMAIN}`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  it("recognizes an owner email and honors as=visitor", async () => {
    const jwt = await token({ email: "OWNER@example.test" });
    const request = new Request("https://archive.test/api/me?as=visitor", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });

    await expect(getViewer(request, authEnv)).resolves.toEqual({ owner: true, viewingAs: "visitor" });
  });

  it("honors as=visitor when DEV_OWNER enables local owner access", async () => {
    const request = new Request("https://archive.test/api/me?as=visitor");
    const env = { ...authEnv, ACCESS_TEAM_DOMAIN: "", DEV_OWNER: "1" };

    await expect(getViewer(request, env)).resolves.toEqual({ owner: true, viewingAs: "visitor" });
  });

  it("recognizes an Access service token by common_name", async () => {
    const jwt = await token({ common_name: "service-client-7" });
    const request = new Request("https://archive.test/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });

    await expect(getViewer(request, authEnv)).resolves.toEqual({ owner: true, viewingAs: "owner" });
  });

  it("treats other email, wrong audience, and a missing assertion as visitor", async () => {
    const otherEmail = await token({ email: "visitor@example.test" });
    const wrongAudience = await token({ email: "owner@example.test" }, "another-app");

    await expect(getViewer(new Request("https://archive.test/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": otherEmail },
    }), authEnv)).resolves.toEqual({ owner: false, viewingAs: "visitor" });
    await expect(getViewer(new Request("https://archive.test/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": wrongAudience },
    }), authEnv)).resolves.toEqual({ owner: false, viewingAs: "visitor" });
    await expect(getViewer(new Request("https://archive.test/api/me"), authEnv))
      .resolves.toEqual({ owner: false, viewingAs: "visitor" });
  });

  it("reads the Access cookie when the assertion header is absent", async () => {
    const jwt = await token({ email: "owner@example.test" });
    const request = new Request("https://archive.test/api/me", {
      headers: { Cookie: `CF_Authorization=${jwt}` },
    });

    await expect(getViewer(request, authEnv)).resolves.toEqual({ owner: true, viewingAs: "owner" });
  });
});

describe("visibility and timeline shaping", () => {
  const visitor = { owner: false, viewingAs: "visitor" as const };
  const owner = { owner: true, viewingAs: "owner" as const };

  it("keeps all year totals and only the allowed topic counts", () => {
    expect(shapeTimelineRows([
      { year: 2023, total: 4, topic_id: "games", topic_count: 2 },
      { year: 2023, total: 4, topic_id: null, topic_count: 0 },
      { year: 2024, total: 1, topic_id: "work", topic_count: 1 },
    ])).toEqual([
      { year: 2023, total: 4, counts: { games: 2 } },
      { year: 2024, total: 1, counts: { work: 1 } },
    ]);
  });

  it("filters topic chips by score, active version, and timeline visibility", () => {
    const rows = [
      { id: "games", score: 0.9, version: "2", topic_version: "2", active: 1, timeline_visibility: "public" as const },
      { id: "work", score: 0.8, version: "1", topic_version: "2", active: 1, timeline_visibility: "public" as const },
      { id: "private", score: 0.95, version: "1", topic_version: "1", active: 1, timeline_visibility: "owner" as const },
      { id: "hidden", score: 0.99, version: "1", topic_version: "1", active: 1, timeline_visibility: "hidden" as const },
      { id: "inactive", score: 0.99, version: "1", topic_version: "1", active: 0, timeline_visibility: "public" as const },
      { id: "low", score: 0.69, version: "1", topic_version: "1", active: 1, timeline_visibility: "public" as const },
    ];

    expect(selectTweetTopicChips(rows, visitor, 0.7)).toEqual([{ id: "games", score: 0.9 }]);
    expect(selectTweetTopicChips(rows, owner, 0.7)).toEqual([
      { id: "private", score: 0.95 },
      { id: "games", score: 0.9 },
    ]);
  });

  it("allows only viewer-visible timeline topics as filters", () => {
    const topics = [
      { id: "games", timeline_visibility: "public" as const, search_visibility: "public" as const, active: 1 },
      { id: "work", timeline_visibility: "owner" as const, search_visibility: "public" as const, active: 1 },
      { id: "secret", timeline_visibility: "hidden" as const, search_visibility: "hidden" as const, active: 1 },
    ];

    expect(isTopicFilterAllowed(["games"], topics, visitor)).toBe(true);
    expect(isTopicFilterAllowed(["work"], topics, visitor)).toBe(false);
    expect(isTopicFilterAllowed(["secret"], topics, owner)).toBe(false);
    expect(isTopicFilterAllowed(["work"], topics, owner)).toBe(true);
  });

  it("shows only public period tags to visitors", () => {
    const tags = [
      { id: "public", visibility: "public" as const },
      { id: "owner", visibility: "owner" as const },
    ];

    expect(filterVisibleTags(tags, visitor)).toEqual([tags[0]]);
    expect(filterVisibleTags(tags, owner)).toEqual(tags);
  });
});

describe("TweetOut and cursor", () => {
  it("serializes the public TweetOut contract", () => {
    expect(serializeTweet({
      id: "123",
      created_at: "2024-05-01T12:30:00.000Z",
      date_kst: "2024-05-01",
      kind: "quote",
      text: "A quoted post",
      parent_id: null,
      parent_text: null,
      parent_author: null,
      quoted_id: "456",
      quoted_text: "Quoted text",
      article_title: "Synthetic API title",
      article_text: "Synthetic API body.",
    }, [
      { type: "photo", r2_key: "2024/05/image.jpg", width: 640, height: 480, alt: "Image" },
      { type: "video", r2_key: null, width: null, height: null, alt: null },
    ], [{ id: "games", score: 0.91 }])).toEqual({
      id: "123",
      created_at: "2024-05-01T12:30:00.000Z",
      date_kst: "2024-05-01",
      kind: "quote",
      text: "A quoted post",
      parent: null,
      quoted: { id: "456", text: "Quoted text" },
      article: { title: "Synthetic API title", text: "Synthetic API body." },
      media: [
        { type: "photo", url: "/media/2024/05/image.jpg", width: 640, height: 480, alt: "Image" },
        { type: "video", url: null, width: null, height: null, alt: null },
      ],
      topics: [{ id: "games", score: 0.91 }],
      x_url: "https://x.com/i/status/123",
    });
  });

  it("serializes missing or empty article titles as null", () => {
    expect(serializeTweet({
      id: "123",
      created_at: "2024-05-01T12:30:00.000Z",
      date_kst: "2024-05-01",
      kind: "original",
      text: "A post",
      parent_id: null,
      parent_text: null,
      parent_author: null,
      quoted_id: null,
      quoted_text: null,
      article_title: "",
      article_text: "Article with an empty title",
    }, [], []).article).toBeNull();
  });

  it("round-trips the created_at and id sort key in a base64url cursor", () => {
    const cursor = encodeCursor({ created_at: "2024-05-01T12:30:00.000Z", id: "123" });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ created_at: "2024-05-01T12:30:00.000Z", id: "123" });
  });
});

describe("media route", () => {
  it("serves an existing R2 object and returns 404 for a missing key", async () => {
    const key = "media/test-media-id/test-image.jpg";
    const object = {
      body: new Response("image bytes").body,
      writeHttpMetadata(headers: Headers) {
        headers.set("Content-Type", "image/jpeg");
      },
    };
    const get = vi.fn(async (requestedKey: string) => requestedKey === key ? object : null);
    const env = { DEV_OWNER: "1", MEDIA: { get } } as unknown as Env;

    const response = await app.request(`/media/${key}`, {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(get).toHaveBeenLastCalledWith(key);

    const missing = await app.request("/media/media/missing.jpg", {}, env);

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(get).toHaveBeenLastCalledWith("media/missing.jpg");
  });
});

describe("robots policy", () => {
  function env(robotsNoindex: string) {
    return {
      DEV_OWNER: "1",
      ROBOTS_NOINDEX: robotsNoindex,
      ASSETS: { fetch: vi.fn(async () => new Response("asset response")) },
    } as unknown as Env;
  }

  it("serves a robots.txt block and adds noindex to API and static responses when enabled", async () => {
    const environment = env("1");

    const robots = await app.request("/robots.txt", {}, environment);
    expect(robots.status).toBe(200);
    expect(robots.headers.get("Content-Type")).toMatch(/^text\/plain/i);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const api = await app.request("/api/health", {}, environment);
    expect(api.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const asset = await app.request("/assets/app.js", {}, environment);
    expect(await asset.text()).toBe("asset response");
    expect(asset.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("leaves API and static response headers unchanged when disabled", async () => {
    const environment = env("");

    const api = await app.request("/api/health", {}, environment);
    expect(api.headers.get("X-Robots-Tag")).toBeNull();

    const asset = await app.request("/assets/app.js", {}, environment);
    expect(await asset.text()).toBe("asset response");
    expect(asset.headers.get("X-Robots-Tag")).toBeNull();

    const robots = await app.request("/robots.txt", {}, environment);
    expect(await robots.text()).toBe("asset response");
    expect(robots.headers.get("X-Robots-Tag")).toBeNull();
  });
});
