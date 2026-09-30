import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

const LINK = "https://example.test/article?id=7";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(text = `Read this: ${LINK}`, hidden = false) {
  const { db, sqlite, reads } = createD1TestDatabase();
  sqlite.prepare(`
    INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source, visibility)
    VALUES ('tweet-1', '2024-01-01T00:00:00.000Z', '2024-01-01', 2024, 1, 'original', ?, 'archive', NULL)
  `).run(text);
  if (hidden) {
    sqlite.prepare(`
      INSERT INTO topics (id, label, question, version, sort_order, active,
        timeline_visibility, search_visibility, public_hide_threshold)
      VALUES ('sensitive', '민감', '민감 주제', 'current', 1, 1, 'public', 'public', 0.5)
    `).run();
    sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES ('tweet-1', 'sensitive', 0.9, 'current')").run();
  }
  return { db, sqlite, reads };
}

async function requestPreview(db: ReturnType<typeof createD1TestDatabase>["db"], url = LINK, asVisitor = false) {
  const query = new URLSearchParams({ tweet: "tweet-1", url });
  if (asVisitor) query.set("as", "visitor");
  return app.fetch(new Request(`https://archive.test/api/link-preview?${query}`), baseTestEnv(db));
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe("GET /api/link-preview", () => {
  it("fetches an OG card, resolves its image, and serves the saved row next time", async () => {
    const { db, sqlite, reads } = fixture();
    const fetchMock = vi.fn(async (input: string | URL) => String(input) === LINK
      ? new Response(null, { status: 302, headers: { Location: "/final/article/index.html" } })
      : new Response(`<!doctype html><head>
        <meta property='og:title' content='A &amp; B'>
        <meta property='og:description' content='A description'>
        <meta property='og:image' content='../images/card.png'>
        <meta property='og:site_name' content='Example &quot;Site&quot;'>
      </head>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await requestPreview(db);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=86400");
    const expected = {
      url: LINK,
      status: "ok",
      title: "A & B",
      description: "A description",
      image: "https://example.test/final/images/card.png",
      site_name: 'Example "Site"',
    };
    expect(await json(first)).toEqual(expected);
    expect(sqlite.prepare("SELECT url, status, title, description, image, site_name FROM link_previews WHERE url = ?").get(LINK)).toEqual({
      url: LINK,
      status: "ok",
      title: "A & B",
      description: "A description",
      image: "https://example.test/final/images/card.png",
      site_name: 'Example "Site"',
    });

    const second = await requestPreview(db);
    expect(await json(second)).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reads.filter(({ query }) => /FROM tweets/i.test(query))).toHaveLength(2);
  });

  it.each([
    ["title element", `<title>Fallback &amp; title</title><meta name="description" content="Plain description">`, "Fallback & title", null],
    ["twitter title", `<meta name="twitter:title" content="Twitter title"><title>Document title</title><meta name="description" content="Plain description">`, "Twitter title", null],
    ["twitter image", `<title>Document title</title><meta name="description" content="Plain description"><meta name="twitter:image" content="/twitter.png">`, "Document title", "https://example.test/twitter.png"],
  ])("uses the %s and description alternatives", async (_name, head, title, image) => {
    const { db } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head>${head}</head></html>`, {
      headers: { "Content-Type": "text/html" },
    })));

    const response = await requestPreview(db);
    expect(await json(response)).toMatchObject({
      url: LINK,
      status: "ok",
      title,
      description: "Plain description",
      image,
      site_name: null,
    });
  });

  it.each([
    ["HTML without usable metadata", new Response("<html><head><title></title></head></html>", { headers: { "Content-Type": "text/html" } })],
    ["non-HTML content", new Response("not html", { headers: { "Content-Type": "application/json" } })],
  ])("returns a cached none result for %s", async (_name, fetched) => {
    const { db } = fixture();
    const fetchMock = vi.fn(async () => fetched);
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestPreview(db);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await json(response)).toEqual({
      url: LINK,
      status: "none",
      title: null,
      description: null,
      image: null,
      site_name: null,
    });
    await requestPreview(db);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("decodes an EUC-KR document using its declared charset", async () => {
    const { db } = fixture();
    const bytes = Uint8Array.from([60, 33, 100, 111, 99, 116, 121, 112, 101, 32, 104, 116, 109, 108, 62, 60, 104, 116, 109, 108, 62, 60, 104, 101, 97, 100, 62, 60, 109, 101, 116, 97, 32, 99, 104, 97, 114, 115, 101, 116, 61, 34, 101, 117, 99, 45, 107, 114, 34, 62, 60, 116, 105, 116, 108, 101, 62, 199, 209, 177, 185, 32, 193, 166, 184, 241, 60, 47, 116, 105, 116, 108, 101, 62, 60, 109, 101, 116, 97, 32, 112, 114, 111, 112, 101, 114, 116, 121, 61, 34, 111, 103, 58, 100, 101, 115, 99, 114, 105, 112, 116, 105, 111, 110, 34, 32, 99, 111, 110, 116, 101, 110, 116, 61, 34, 199, 209, 177, 185, 32, 188, 179, 184, 237, 34, 62, 60, 47, 104, 101, 97, 100, 62, 60, 47, 104, 116, 109, 108, 62]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, {
      headers: { "Content-Type": "text/html" },
    })));

    const response = await requestPreview(db);
    expect(await json(response)).toMatchObject({
      status: "ok",
      title: "한국 제목",
      description: "한국 설명",
    });
  });

  it("returns error and caches a request aborted by the five-second timeout", async () => {
    const { db } = fixture();
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = requestPreview(db);
    await vi.advanceTimersByTimeAsync(5000);
    const response = await responsePromise;
    expect(await json(response)).toMatchObject({ url: LINK, status: "error" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await requestPreview(db);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns and saves error for a 5xx response", async () => {
    const { db } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    const response = await requestPreview(db);
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(await json(response)).toMatchObject({ url: LINK, status: "error" });
  });

  it("stops after five redirects", async () => {
    const { db } = fixture();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://redirect.example/next" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestPreview(db);
    expect(await json(response)).toMatchObject({ url: LINK, status: "error" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("reads no more than the first 512 KB of HTML", async () => {
    const { db } = fixture();
    const html = `<html><head>${" ".repeat(512 * 1024)}<meta property="og:title" content="too late"></head></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { headers: { "Content-Type": "text/html" } })));

    const response = await requestPreview(db);
    expect(await json(response)).toMatchObject({ url: LINK, status: "none", title: null });
  });

  it("returns 404 for hidden tweets, missing source links, unsupported schemes, and X hosts", async () => {
    const hidden = fixture(`Read this: ${LINK}`, true);
    const missing = fixture("No matching link here");
    const fetchMock = vi.fn(async () => new Response("should not fetch", { headers: { "Content-Type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await requestPreview(hidden.db, LINK, true)).status).toBe(404);
    expect((await requestPreview(missing.db)).status).toBe(404);
    expect(hidden.reads.filter(({ query }) => /FROM tweets/i.test(query))).toHaveLength(1);
    expect(hidden.reads[0]?.query).toContain("public_hide_threshold");
    expect(missing.reads.filter(({ query }) => /FROM tweets/i.test(query))).toHaveLength(1);
    const hostReads = [] as string[];
    for (const url of [
      "https://x.com/eiaserinnys/status/1",
      "https://twitter.com/eiaserinnys/status/1",
      "https://t.co/abc123",
      "ftp://example.test/article",
    ]) {
      const { db, reads } = fixture(`Read this: ${url}`);
      expect((await requestPreview(db, url)).status).toBe(404);
      hostReads.push(...reads.filter(({ query }) => /FROM tweets/i.test(query)).map(({ query }) => query));
    }
    expect(hostReads).toHaveLength(4);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
