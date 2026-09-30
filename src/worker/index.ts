import { Hono } from "hono";
import {
  clearOwnerSessionCookie,
  createOwnerSessionCookie,
  getViewer,
  verifyOwnerPassword,
  type Viewer,
} from "./auth.js";
import type { Env } from "./env.js";
import meRoute from "./routes/me.js";
import metaRoute from "./routes/meta.js";
import timelineRoute from "./routes/timeline.js";
import tweetsRoute from "./routes/tweets.js";
import topicsRoute from "./routes/topics.js";
import tagsRoute from "./routes/tags.js";
import searchRoute from "./routes/search.js";
import linkPreviewRoute from "./routes/link-preview.js";
import { handleScheduled } from "./scheduled.js";

const app = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

app.use("*", async (context, next) => {
  context.set("viewer", await getViewer(context.req.raw, context.env));
  await next();
  if (context.env.ROBOTS_NOINDEX === "1") context.header("X-Robots-Tag", "noindex, nofollow");
});

app.get("/api/health", (context) => context.json({ ok: true }));
app.route("/", meRoute);
app.route("/", metaRoute);
app.route("/", timelineRoute);
app.route("/", tweetsRoute);
app.route("/", topicsRoute);
app.route("/", tagsRoute);
app.route("/", searchRoute);
app.route("/", linkPreviewRoute);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function ownerLoginPage(siteTitle: string, failed = false): Response {
  const title = escapeHtml(siteTitle);
  const error = failed ? '<p class="foot" role="alert">비밀번호를 확인해 주세요.</p>' : "";
  return new Response(`<!doctype html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<div class="shell">
<main>
<h1 class="handle">${title}</h1>
<form class="search" method="post" action="">
<span class="prompt" aria-hidden="true">&gt;</span>
<label class="sr-only" for="owner-password">비밀번호</label>
<input id="owner-password" type="password" name="password" autocomplete="current-password" placeholder="비밀번호" required>
<button class="btn acid" type="submit">로그인</button>
</form>
${error}
</main>
</div>
</body>
</html>`, {
    status: failed ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

app.get("/owner", (context) => {
  if (context.env.OWNER_AUTH !== "password" || context.get("viewer").owner) {
    return context.redirect("/", 302);
  }
  return ownerLoginPage(context.env.SITE_TITLE);
});
app.post("/owner", async (context) => {
  if (context.env.OWNER_AUTH !== "password") return context.text("Not Found", 404);
  const form = new URLSearchParams(await context.req.text());
  const password = form.get("password") ?? "";
  if (!await verifyOwnerPassword(password, context.env.OWNER_PASSWORD)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return ownerLoginPage(context.env.SITE_TITLE, true);
  }
  const response = context.redirect("/", 303);
  response.headers.set("Set-Cookie", await createOwnerSessionCookie(context.req.raw, context.env.OWNER_PASSWORD!));
  return response;
});
app.get("/logout", (context) => {
  if (context.env.OWNER_AUTH !== "password") return context.redirect("/cdn-cgi/access/logout", 302);
  const response = context.redirect("/", 303);
  response.headers.set("Set-Cookie", clearOwnerSessionCookie(context.req.raw));
  return response;
});
app.get("/robots.txt", async (context) => {
  if (context.env.ROBOTS_NOINDEX !== "1") return context.env.ASSETS.fetch(context.req.raw);
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});
app.get("/media/*", async (context) => {
  const key = decodeURIComponent(context.req.path.slice("/media/".length));
  const object = key ? await context.env.MEDIA.get(key) : null;
  if (!object) return context.json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

app.notFound((context) => context.req.path.startsWith("/api/")
  ? context.json({ error: "not_found" }, 404)
  : context.env.ASSETS.fetch(context.req.raw));
app.onError((_error, context) => context.json({ error: "internal", message: "Internal server error." }, 500));

export { app };

async function processResponse(
  response: Response,
  basePath: string,
  umamiScriptUrl?: string,
  umamiWebsiteId?: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  const location = headers.get("Location");
  if (basePath && location?.startsWith("/") && !location.startsWith("/cdn-cgi/")) {
    headers.set("Location", `${basePath}${location}`);
  }

  if (headers.get("Content-Type")?.includes("text/html")) {
    let html = await response.text();
    if (basePath) {
      html = html.replace(/\b(src|href)="\/(?!\/|cdn-cgi\/)/g, (_match, attribute: string) => `${attribute}="${basePath}/`);
    }
    const umami = umamiScriptUrl && umamiWebsiteId
      ? `<script defer src="${escapeHtml(umamiScriptUrl)}" data-website-id="${escapeHtml(umamiWebsiteId)}"></script>`
      : "";
    const headContents = `${basePath ? `<meta name="base-path" content="${basePath}">` : ""}${umami}`;
    if (headContents) html = html.replace("<head>", `<head>${headContents}`);
    headers.delete("Content-Length");
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  }

  if (!basePath) return response;
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function fetch(request: Request, env: Env, executionCtx?: Parameters<typeof app.fetch>[2]): Promise<Response> {
  const basePath = env.BASE_PATH;
  const hasUmami = Boolean(env.UMAMI_SCRIPT_URL && env.UMAMI_WEBSITE_ID);
  if (!basePath && !hasUmami) return app.fetch(request, env, executionCtx);

  let appRequest = request;
  if (basePath) {
    const url = new URL(request.url);
    if (url.pathname === basePath) {
      url.pathname += "/";
      return Response.redirect(url.toString(), 301);
    }
    if (!url.pathname.startsWith(`${basePath}/`)) return new Response("Not Found", { status: 404 });
    url.pathname = url.pathname.slice(basePath.length);
    appRequest = new Request(url, request);
  }
  const response = await app.fetch(appRequest, env, executionCtx);
  return processResponse(response, basePath, env.UMAMI_SCRIPT_URL, env.UMAMI_WEBSITE_ID);
}

export default { fetch, scheduled: handleScheduled };
