import { Hono } from "hono";
import { getTweetStats } from "../db/meta.js";
import { getTopic, getTopicInfo, listTopicRows, type TopicInfo } from "../db/topics.js";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { randomId } from "../ids.js";
import { bumpDataVersion, dataVersionStatement } from "../db/meta.js";
import type { AppContext } from "./helpers.js";
import { invalid, isVisibility, ownerJsonBody, ownerOnly } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= maxLength;
}

function isPublicHideThreshold(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

function rescoreEstimate(tweets: number, scoreBatch: string) {
  return {
    tweets,
    est_usd: tweets * 400 * 0.042 / 1_000_000,
    est_minutes: Math.ceil(tweets / Number(scoreBatch)),
  };
}

function rescoreStatement(context: AppContext, id: string, version: string) {
  return context.env.DB.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(`rescore:${id}`, JSON.stringify({ version, cursor: "" }));
}

async function runBatch(context: AppContext, statements: ReturnType<Env["DB"]["prepare"]>[]) {
  if (!context.env.DB.batch) throw new Error("D1 batch execution is unavailable.");
  const results = await context.env.DB.batch(statements);
  if (results.some((result) => !result.success)) throw new Error("D1 rejected a topic update batch.");
  return results;
}

async function ownerTopicInfo(context: AppContext, id: string): Promise<TopicInfo | null> {
  return getTopicInfo(context.env.DB, id);
}

route.get("/api/topics/:id/score-histogram", async (context: AppContext) => {
  const denied = ownerOnly(context);
  if (denied) return denied;
  const id = context.req.param("id") ?? "";
  const topic = await getTopic(context.env.DB, id);
  if (!topic || !topic.active) return context.json({ error: "not_found" }, 404);
  const result = await context.env.DB.prepare(`
    SELECT MIN(19, CAST(score * 20 AS INTEGER)) AS bucket, COUNT(*) AS count
    FROM scores WHERE topic = ? GROUP BY bucket
  `).bind(id).all<{ bucket: number; count: number }>();
  const buckets = Array<number>(20).fill(0);
  for (const row of result.results) buckets[row.bucket] = row.count;
  return context.json({ buckets });
});

route.post("/api/topics", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;
  if (!validText(body.label, 40) || !validText(body.question, 200)
    || !isVisibility(body.timeline_visibility) || !isVisibility(body.search_visibility)
    || ("public_hide_threshold" in body && !isPublicHideThreshold(body.public_hide_threshold))) {
    return invalid(context, "Topic fields are invalid.");
  }
  const rows = await listTopicRows(context.env.DB);
  const sortOrder = Math.max(0, ...rows.map((row) => row.sort_order)) + 1;
  const id = randomId("t_");
  const version = String(Date.now());
  await runBatch(context, [context.env.DB.prepare(`
    INSERT INTO topics (id, label, question, version, sort_order, active,
      timeline_visibility, search_visibility, public_hide_threshold)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(id, body.label, body.question, version, sortOrder,
    body.timeline_visibility, body.search_visibility, body.public_hide_threshold ?? null), rescoreStatement(context, id, version),
  dataVersionStatement(context.env.DB)]);
  const [topic, stats] = await Promise.all([
    ownerTopicInfo(context, id),
    getTweetStats(context.env.DB, context.get("viewer")),
  ]);
  if (!topic) throw new Error("Created topic was not found.");
  return context.json({ topic, rescore_estimate: rescoreEstimate(stats.total_tweets, context.env.SCORE_BATCH) }, 201);
});

route.patch("/api/topics/:id", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const current = await getTopic(context.env.DB, context.req.param("id") ?? "");
  if (!current || !current.active) return context.json({ error: "not_found" }, 404);
  const body = parsed.body;
  if (("label" in body && !validText(body.label, 40))
    || ("question" in body && !validText(body.question, 200))
    || ("timeline_visibility" in body && !isVisibility(body.timeline_visibility))
    || ("search_visibility" in body && !isVisibility(body.search_visibility))
    || ("public_hide_threshold" in body && !isPublicHideThreshold(body.public_hide_threshold))
    || ("sort_order" in body && (typeof body.sort_order !== "number" || !Number.isInteger(body.sort_order)))) {
    return invalid(context, "Topic fields are invalid.");
  }
  const columns: Array<[string, string]> = [
    ["label", "label"],
    ["question", "question"],
    ["timeline_visibility", "timeline_visibility"],
    ["search_visibility", "search_visibility"],
    ["public_hide_threshold", "public_hide_threshold"],
    ["sort_order", "sort_order"],
  ];
  const updates = columns.filter(([key]) => key in body);
  const questionChanged = typeof body.question === "string" && body.question !== current.question;
  if (questionChanged) updates.push(["version", "version"]);
  if (updates.length > 0) {
    const values = updates.map(([key]) => key === "version" ? String(Date.now()) : body[key]);
    const setClause = updates.map(([, column]) => `${column} = ?`).join(", ");
    const update = context.env.DB.prepare(`UPDATE topics SET ${setClause} WHERE id = ?`)
      .bind(...values, current.id);
    if (questionChanged) {
      const version = String(values[updates.findIndex(([key]) => key === "version")]);
      await runBatch(context, [update, rescoreStatement(context, current.id, version), dataVersionStatement(context.env.DB)]);
    } else {
      await update.run();
      await bumpDataVersion(context.env.DB);
    }
  }
  const [topic, stats] = await Promise.all([
    ownerTopicInfo(context, current.id),
    getTweetStats(context.env.DB, context.get("viewer")),
  ]);
  if (!topic) throw new Error("Updated topic was not found.");
  return context.json({
    topic,
    rescored: questionChanged,
    rescore_estimate: rescoreEstimate(stats.total_tweets, context.env.SCORE_BATCH),
  });
});

route.delete("/api/topics/:id", async (context: AppContext) => {
  const denied = ownerOnly(context);
  if (denied) return denied;
  const id = context.req.param("id") ?? "";
  const results = await runBatch(context, [
    context.env.DB.prepare("UPDATE topics SET active = 0 WHERE id = ?").bind(id),
    context.env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(`rescore:${id}`),
  ]);
  if (!results[0].meta.changes) return context.json({ error: "not_found" }, 404);
  await bumpDataVersion(context.env.DB);
  return context.json({ ok: true });
});

export default route;
