import { describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

describe("Worker base path boundary", () => {
  function environment(basePath = "/twitter") {
    const { db } = createD1TestDatabase();
    return baseTestEnv(db, { BASE_PATH: basePath });
  }

  const fetch = (path: string, env: ReturnType<typeof environment>, init?: RequestInit) =>
    worker.fetch(new Request(`https://archive.test${path}`, init), env);

  it("redirects the exact mount to its slash URL and preserves the query", async () => {
    const response = await fetch("/twitter?q=test", environment());
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://archive.test/twitter/?q=test");
  });

  it("strips the prefix and retains method, body, headers and query", async () => {
    const env = environment();
    const response = await fetch("/twitter/api/search?as=visitor", env, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"q":"test"}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "free_query_disabled" });
    expect(await (await fetch("/twitter/api/me?as=visitor", env)).json())
      .toEqual({ owner: true, viewing_as: "visitor" });
  });

  it("returns 404 outside the mounted namespace without calling assets", async () => {
    const env = environment();
    const assets = vi.fn(async () => new Response("asset"));
    env.ASSETS.fetch = assets;
    for (const path of ["/", "/twitter-other/", "/api/health"]) {
      expect((await fetch(path, env)).status).toBe(404);
    }
    expect(assets).not.toHaveBeenCalled();
  });

  it("passes prefix-free paths to assets and media", async () => {
    const env = environment();
    const assets = vi.fn(async (request: Request) => new Response(new URL(request.url).pathname));
    env.ASSETS.fetch = assets;
    const response = await fetch("/twitter/assets/app.js", env);
    expect(await response.text()).toBe("/assets/app.js");
    const media = vi.fn(async () => null);
    env.MEDIA.get = media;
    expect((await fetch("/twitter/media/synthetic.png", env)).status).toBe(404);
    expect(media).toHaveBeenCalledWith("synthetic.png");
  });

  it("prefixes root redirects and leaves Access and absolute redirects intact", async () => {
    const env = environment();
    const owner = await fetch("/twitter/owner", env);
    expect(owner.status).toBe(302);
    expect(owner.headers.get("Location")).toBe("/twitter/");
    for (const location of ["/cdn-cgi/access/logout", "https://external.test/"]) {
      env.ASSETS.fetch = async () => new Response(null, { status: 302, headers: { Location: location } });
      expect((await fetch("/twitter/redirect", env)).headers.get("Location")).toBe(location);
    }
  });

  it("rewrites HTML attributes, preserves external/Access URLs, and inserts base metadata", async () => {
    const env = environment();
    env.ASSETS.fetch = async () => new Response(
      '<html><head><link href="/assets/styles.css"></head><body><script src="/assets/app.js"></script>'
      + '<a href="/owner">login</a><a href="/cdn-cgi/access/logout">logout</a>'
      + '<img src="//cdn.test/a.png"><a href="https://external.test/">external</a></body></html>',
      { headers: { "Content-Type": "text/html; charset=utf-8", "X-Test": "retained" } },
    );
    const response = await fetch("/twitter/year/2024", env);
    expect(response.headers.get("X-Test")).toBe("retained");
    expect(await response.text()).toBe(
      '<html><head><meta name="base-path" content="/twitter"><link href="/twitter/assets/styles.css"></head><body>'
      + '<script src="/twitter/assets/app.js"></script><a href="/twitter/owner">login</a>'
      + '<a href="/cdn-cgi/access/logout">logout</a><img src="//cdn.test/a.png">'
      + '<a href="https://external.test/">external</a></body></html>',
    );
  });

  it("keeps empty BASE_PATH behavior unchanged for API, assets, HTML and redirects", async () => {
    const env = environment("");
    expect(await (await fetch("/api/health", env)).json()).toEqual({ ok: true });
    expect((await fetch("/owner", env)).headers.get("Location")).toBe("/");
    const html = '<head></head><script src="/assets/app.js"></script>';
    env.ASSETS.fetch = async () => new Response(html, { headers: { "Content-Type": "text/html" } });
    expect(await (await fetch("/", env)).text()).toBe(html);
  });
});
