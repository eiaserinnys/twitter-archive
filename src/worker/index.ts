import { Hono } from "hono";
import { getViewer, type Viewer } from "./auth.js";
import type { Env } from "./env.js";
import meRoute from "./routes/me.js";
import metaRoute from "./routes/meta.js";
import timelineRoute from "./routes/timeline.js";
import tweetsRoute from "./routes/tweets.js";
import topicsRoute from "./routes/topics.js";
import tagsRoute from "./routes/tags.js";
import searchRoute from "./routes/search.js";
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

app.get("/owner", (context) => context.redirect("/", 302));
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

async function fetch(request: Request, env: Env, executionCtx?: Parameters<typeof app.fetch>[2]): Promise<Response> {
  const basePath = env.BASE_PATH;
  if (!basePath) return app.fetch(request, env, executionCtx);

  const url = new URL(request.url);
  if (url.pathname === basePath) {
    url.pathname += "/";
    return Response.redirect(url.toString(), 301);
  }
  if (!url.pathname.startsWith(`${basePath}/`)) return new Response("Not Found", { status: 404 });
  url.pathname = url.pathname.slice(basePath.length);
  const response = await app.fetch(new Request(url, request), env, executionCtx);
  const headers = new Headers(response.headers);
  const location = headers.get("Location");
  if (location?.startsWith("/") && !location.startsWith("/cdn-cgi/")) {
    headers.set("Location", `${basePath}${location}`);
  }
  if (headers.get("Content-Type")?.includes("text/html")) {
    const html = (await response.text())
      .replace(/\b(src|href)="\/(?!\/|cdn-cgi\/)/g, (_match, attribute: string) => `${attribute}="${basePath}/`)
      .replace("<head>", `<head><meta name="base-path" content="${basePath}">`);
    headers.delete("Content-Length");
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default { fetch, scheduled: handleScheduled };
