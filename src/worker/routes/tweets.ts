import { Hono } from "hono";
import type { Viewer } from "../auth.js";
import { decodeCursor } from "../cursor.js";
import { getOnThisDayTweets, queryTweets } from "../db/tweets.js";
import { getDatesForOnThisDay } from "../db/timeline.js";
import type { Env } from "../env.js";
import { serializeTweetRows } from "../db/tweets.js";
import { listTopicRows } from "../db/topics.js";
import { bumpDataVersion, getReplyVisibility } from "../db/meta.js";
import { publicHiddenSql, isTopicFilterAllowed } from "../visibility.js";
import type { AppContext } from "./helpers.js";
import { invalid, isDate, ownerJsonBody } from "./helpers.js";
import { OTHER_TOPIC_ID, isOtherTopicEnabled, otherTopic } from "../other-topic.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();
const tweetKinds = ["original", "reply", "self_reply", "quote"];

route.patch("/api/tweets/:id", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const id = context.req.param("id") ?? "";
  const current = await context.env.DB.prepare("SELECT id FROM tweets WHERE id = ?").bind(id).first<{ id: string }>();
  if (!current) return context.json({ error: "not_found" }, 404);
  const visibility = parsed.body.visibility;
  if (!(visibility === null || visibility === "private" || visibility === "public")) {
    return invalid(context, "Tweet visibility is invalid.");
  }
  await context.env.DB.prepare("UPDATE tweets SET visibility = ? WHERE id = ?").bind(visibility, id).run();
  await bumpDataVersion(context.env.DB);
  const hidden = await context.env.DB.prepare(`
    SELECT CASE WHEN ${publicHiddenSql("t")} THEN 1 ELSE 0 END AS public_hidden
    FROM tweets t WHERE t.id = ?
  `).bind(id).first<{ public_hidden: number }>();
  return context.json({ visibility, public_hidden: Boolean(hidden?.public_hidden) });
});

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

route.get("/api/tweets", async (context: AppContext) => {
  const params = context.req.query();
  const year = parseInteger(params.year);
  const month = parseInteger(params.month);
  const limit = params.limit === undefined ? 50 : parseInteger(params.limit);
  if ((params.year !== undefined && year === undefined)
    || (params.month !== undefined && month === undefined)
    || (month !== undefined && (year === undefined || month < 1 || month > 12))
    || (params.date !== undefined && !isDate(params.date))
    || (params.from !== undefined && !isDate(params.from))
    || (params.to !== undefined && !isDate(params.to))
    || (params.from && params.to && params.from > params.to)
    || limit === undefined || limit < 1 || limit > 200
    || (params.order !== undefined && params.order !== "asc" && params.order !== "desc")) {
    return invalid(context, "Tweet filters are invalid.");
  }
  const topics = params.topics?.split(",").map((id) => id.trim()).filter(Boolean);
  const kinds = params.kind?.split(",").map((kind) => kind.trim()).filter(Boolean);
  if (kinds?.some((kind) => !tweetKinds.includes(kind))) return invalid(context, "Tweet kind is invalid.");
  if (topics?.length) {
    const topicRows = await listTopicRows(context.env.DB);
    if (topics.includes(OTHER_TOPIC_ID) && await isOtherTopicEnabled(context.env.DB)) {
      topicRows.push(otherTopic());
    }
    if (!isTopicFilterAllowed(topics, topicRows, context.get("viewer"))) {
      return context.json({ error: "topic_not_allowed" }, 400);
    }
  }
  let cursor;
  if (params.cursor) {
    try {
      cursor = decodeCursor(params.cursor);
    } catch {
      return invalid(context, "Cursor is invalid.");
    }
  }
  return context.json(await queryTweets(context.env.DB, context.get("viewer"), {
    year,
    month,
    date: params.date,
    from: params.from,
    to: params.to,
    topics,
    kinds,
    q: params.q,
    public_hidden: context.get("viewer").viewingAs === "owner" && params.public_hidden === "1",
    order: params.order === "desc" ? "desc" : "asc",
    limit,
    cursor,
  }));
});

route.get("/api/on-this-day", async (context: AppContext) => {
  const md = context.req.query("md");
  if (!md || !/^\d{2}-\d{2}$/.test(md) || !isDate(`2000-${md}`)) {
    return invalid(context, "md must use MM-DD format.");
  }
  const viewer = context.get("viewer");
  const replies = await getReplyVisibility(context.env.DB);
  const dates = await getDatesForOnThisDay(context.env.DB, viewer, replies);
  const [month, day] = md.split("-").map(Number);
  const closestByYear = new Map<number, { date: string; distance_days: number }>();
  for (const candidate of dates) {
    const target = new Date(Date.UTC(candidate.year, month - 1, day)).toISOString().slice(0, 10);
    const distance = Math.abs(dateDayNumber(candidate.date) - dateDayNumber(target));
    const closest = closestByYear.get(candidate.year);
    if (!closest || distance < closest.distance_days
      || (distance === closest.distance_days && candidate.date < closest.date)) {
      closestByYear.set(candidate.year, { date: candidate.date, distance_days: distance });
    }
  }
  const selected = [...closestByYear.entries()]
    .sort(([left], [right]) => right - left)
    .map(([year, value]) => ({ year, ...value }));
  const rows = await getOnThisDayTweets(context.env.DB, selected.map((entry) => entry.date), viewer, replies);
  const serialized = await serializeTweetRows(context.env.DB, rows, viewer);
  const tweetsByDate = new Map<string, typeof serialized>();
  rows.forEach((row, index) => {
    const items = tweetsByDate.get(row.date_kst) ?? [];
    items.push(serialized[index]);
    tweetsByDate.set(row.date_kst, items);
  });
  const totalByDate = new Map(rows.map((row) => [row.date_kst, row.day_total]));
  return context.json({
    md,
    years: selected.map((entry) => ({
      ...entry,
      total: totalByDate.get(entry.date) ?? 0,
      tweets: tweetsByDate.get(entry.date) ?? [],
    })),
  });
});

function dateDayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export default route;
