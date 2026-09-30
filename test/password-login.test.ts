import { describe, expect, it } from "vitest";
import worker from "../src/worker/index.js";
import { app } from "../src/worker/index.js";
import type { Env } from "../src/worker/env.js";

const password = "synthetic-owner-password";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    SITE_TITLE: "Synthetic Archive",
    BASE_PATH: "",
    OWNER_AUTH: "password",
    OWNER_PASSWORD: password,
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    OWNER_EMAILS: "",
    OWNER_SERVICE_TOKEN_IDS: "",
    DEV_OWNER: undefined,
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) },
    ...overrides,
  } as unknown as Env;
}

function postPassword(path: string, value: string, protocol = "https:", headers: HeadersInit = {}) {
  const body = new URLSearchParams({ password: value });
  const requestHeaders = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  new Headers(headers).forEach((headerValue, name) => requestHeaders.set(name, headerValue));
  return new Request(`${protocol}//archive.test${path}`, {
    method: "POST",
    headers: requestHeaders,
    body,
  });
}

function cookieValue(setCookie: string): string {
  return setCookie.split(";", 1)[0].slice("ta_owner=".length);
}

async function signSession(secret: string, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expires))));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${expires}.${signature}`;
}

describe("password owner login", () => {
  it("renders a minimal same-path form and rejects a wrong password after a short delay", async () => {
    const env = environment();
    const page = await app.request("/owner", {}, env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Synthetic Archive</title>");
    expect(html).toContain('<form class="search" method="post" action="">');
    expect(html).toContain('name="password"');

    const started = performance.now();
    const response = await app.request(postPassword("/owner", "incorrect-password"), {}, env);
    expect(performance.now() - started).toBeGreaterThanOrEqual(500);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("비밀번호를 확인해 주세요.");
  });

  it("issues a 30-day signed cookie and uses it for owner and visitor views", async () => {
    const env = environment();
    const response = await app.request(postPassword("/owner", password), {}, env);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");

    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).toMatch(/^ta_owner=\d+\.[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");

    const token = cookieValue(setCookie!);
    const owner = await app.request("/api/me", { headers: { Cookie: `ta_owner=${token}` } }, env);
    expect(await owner.json()).toEqual({
      owner: true,
      viewing_as: "owner",
      login_url: "/owner",
      logout_url: "/logout",
    });
    const alreadyOwner = await app.request("/owner", { headers: { Cookie: `ta_owner=${token}` } }, env);
    expect(alreadyOwner.status).toBe(302);
    expect(alreadyOwner.headers.get("Location")).toBe("/");
    const visitor = await app.request("/api/me?as=visitor", { headers: { Cookie: `ta_owner=${token}` } }, env);
    expect(await visitor.json()).toMatchObject({ owner: true, viewing_as: "visitor" });
  });

  it("rejects tampered, expired, and old-password cookies", async () => {
    const env = environment();
    const response = await app.request(postPassword("/owner", password), {}, env);
    const token = cookieValue(response.headers.get("Set-Cookie")!);
    const [expires, signature] = token.split(".");
    const tampered = `${expires}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const expired = await signSession(password, Math.floor(Date.now() / 1000) - 1);
    const oldPassword = await signSession("previous-owner-password", Number(expires));

    for (const cookie of [tampered, expired, oldPassword]) {
      const me = await app.request("/api/me", { headers: { Cookie: `ta_owner=${cookie}` } }, env);
      expect(await me.json()).toMatchObject({ owner: false, viewing_as: "visitor" });
    }
  });

  it("rejects missing or shorter-than-12-character configured passwords", async () => {
    for (const env of [
      environment({ OWNER_PASSWORD: "short" }),
      environment({ OWNER_PASSWORD: undefined }),
    ]) {
      const response = await app.request(postPassword("/owner", "a-long-enough-password"), {}, env);
      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("clears the password session on logout and keeps Secure tied to the request", async () => {
    const env = environment();
    const login = await app.request(postPassword("/owner", password, "http:"), {}, env);
    const insecureCookie = login.headers.get("Set-Cookie")!;
    expect(insecureCookie).not.toContain("Secure");

    const forwardedHttps = await app.request(postPassword("/owner", password, "http:", {
      "X-Forwarded-Proto": "https",
    }), {}, env);
    expect(forwardedHttps.headers.get("Set-Cookie")).toContain("Secure");

    const token = cookieValue(insecureCookie);
    const logout = await app.request(new Request("https://archive.test/logout", {
      headers: { Cookie: `ta_owner=${token}` },
    }), {}, env);
    expect(logout.status).toBe(303);
    expect(logout.headers.get("Location")).toBe("/");
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("Set-Cookie")).toContain("Secure");

    const me = await app.request("/api/me", {}, env);
    expect(await me.json()).toMatchObject({ owner: false, viewing_as: "visitor" });
  });

  it("returns base-path aware login links and redirects after login", async () => {
    const env = environment({ BASE_PATH: "/twitter" });
    const page = await worker.fetch(new Request("https://archive.test/twitter/owner"), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<form class="search" method="post" action="">');
    expect(html).toContain('href="/twitter/assets/styles.css"');

    const login = await worker.fetch(postPassword("/twitter/owner", password), env);
    expect(login.status).toBe(303);
    expect(login.headers.get("Location")).toBe("/twitter/");
  });

  it("keeps Access login and logout behavior when password auth is disabled", async () => {
    const env = environment({ OWNER_AUTH: "access", OWNER_PASSWORD: undefined });
    const ownerPage = await app.request("/owner", {}, env);
    expect(ownerPage.status).toBe(302);
    expect(ownerPage.headers.get("Location")).toBe("/");

    const post = await app.request(postPassword("/owner", password), {}, env);
    expect(post.status).toBe(404);

    const logout = await app.request("/logout", {}, env);
    expect(logout.status).toBe(302);
    expect(logout.headers.get("Location")).toBe("/cdn-cgi/access/logout");

    const me = await app.request("/api/me", {}, env);
    expect(await me.json()).toEqual({
      owner: false,
      viewing_as: "visitor",
      login_url: "/owner",
      logout_url: "/cdn-cgi/access/logout",
    });
  });
});
