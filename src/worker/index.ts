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
export default { fetch: app.fetch, scheduled: handleScheduled };
