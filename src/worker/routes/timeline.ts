import { Hono } from "hono";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { daysBetween, todayKst } from "../dates.js";
import { getCalendarCounts, getMonthCounts, getTimelineCounts } from "../db/timeline.js";
import { visibleTags } from "../db/tags.js";
import { shapeTimelineRows } from "../visibility.js";
import type { AppContext } from "./helpers.js";
import { invalid } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.get("/api/timeline", async (context: AppContext) => {
  const viewer = context.get("viewer");
  const [rows, tags] = await Promise.all([
    getTimelineCounts(context.env.DB, viewer),
    visibleTags(context.env.DB, viewer),
  ]);
  const today = todayKst();
  const long = [];
  const shortCounts: Record<string, number> = {};
  for (const tag of tags) {
    const end = tag.end_date ?? today;
    if (daysBetween(tag.start_date, end) >= 365) {
      long.push(tag);
      continue;
    }
    const firstYear = Number(tag.start_date.slice(0, 4));
    const lastYear = Number(end.slice(0, 4));
    for (let year = firstYear; year <= lastYear; year += 1) {
      const key = String(year);
      shortCounts[key] = (shortCounts[key] ?? 0) + 1;
    }
  }
  return context.json({
    years: shapeTimelineRows(rows),
    tags: { long, short_counts: shortCounts },
  });
});

route.get("/api/timeline/:year", async (context: AppContext) => {
  const rawYear = context.req.param("year") ?? "";
  if (!/^\d{4}$/.test(rawYear)) return invalid(context, "Year must use YYYY format.");
  const year = Number(rawYear);
  const viewer = context.get("viewer");
  const [rows, allTags] = await Promise.all([
    getMonthCounts(context.env.DB, year, viewer),
    visibleTags(context.env.DB, viewer),
  ]);
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    total: 0,
    counts: {} as Record<string, number>,
  }));
  for (const row of rows) {
    const month = months[row.month - 1];
    month.total = row.total;
    if (row.topic_id && row.topic_count > 0) month.counts[row.topic_id] = row.topic_count;
  }
  const firstDate = `${rawYear}-01-01`;
  const lastDate = `${rawYear}-12-31`;
  const today = todayKst();
  const tags = allTags.filter((tag) => tag.start_date <= lastDate
    && (tag.end_date ?? today) >= firstDate);
  return context.json({ year, months, tags });
});

route.get("/api/calendar", async (context: AppContext) => {
  const rawYear = context.req.query("year");
  const rawMonth = context.req.query("month");
  if (!rawYear || !/^\d{4}$/.test(rawYear) || !rawMonth || !/^\d{1,2}$/.test(rawMonth)) {
    return invalid(context, "Year and month are required.");
  }
  const year = Number(rawYear);
  const month = Number(rawMonth);
  if (month < 1 || month > 12) return invalid(context, "Month must be between 1 and 12.");
  const rows = await getCalendarCounts(context.env.DB, year, month, context.get("viewer"));
  const days = new Map<string, { date: string; total: number; top_topic: string | null }>();
  for (const row of rows) {
    let day = days.get(row.date);
    if (!day) {
      day = { date: row.date, total: row.total, top_topic: row.topic_id };
      days.set(row.date, day);
    }
    if (day.top_topic === null && row.topic_id !== null) day.top_topic = row.topic_id;
  }
  return context.json({ year, month, days: [...days.values()] });
});

export default route;
