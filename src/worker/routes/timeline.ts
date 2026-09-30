import { Hono } from "hono";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { getOrCacheJson } from "../cache.js";
import { daysBetween, todayKst } from "../dates.js";
import { getDataVersion, getReplyVisibility } from "../db/meta.js";
import { getCalendarCounts, getMonthCounts, getTimelineCounts } from "../db/timeline.js";
import { visibleTags } from "../db/tags.js";
import { shapeTimelineRows } from "../visibility.js";
import type { AppContext } from "./helpers.js";
import { invalid } from "./helpers.js";
import { getOtherCounts, isOtherTopicEnabled, OTHER_TOPIC_ID } from "../other-topic.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.get("/api/timeline", async (context: AppContext) => {
  const viewer = context.get("viewer");
  const today = todayKst();
  const dataVersion = await getDataVersion(context.env.DB);
  const response = await getOrCacheJson(
    context.req.raw,
    dataVersion,
    viewer.viewingAs,
    async () => {
      const replies = await getReplyVisibility(context.env.DB);
      const [rows, tags, otherEnabled] = await Promise.all([
        getTimelineCounts(context.env.DB, viewer, replies),
        visibleTags(context.env.DB, viewer),
        isOtherTopicEnabled(context.env.DB),
      ]);
      const years = shapeTimelineRows(rows);
      if (otherEnabled) {
        for (const row of await getOtherCounts(context.env.DB, "year", viewer, replies)) {
          years.find(year => year.year === row.period)!.counts[OTHER_TOPIC_ID] = row.other_count;
        }
      }
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
      return { years, tags: { long, short_counts: shortCounts } };
    },
    today,
    context.env.CF_VERSION_METADATA?.id,
  );
  return context.json(response);
});

route.get("/api/timeline/:year", async (context: AppContext) => {
  const rawYear = context.req.param("year") ?? "";
  if (!/^\d{4}$/.test(rawYear)) return invalid(context, "Year must use YYYY format.");
  const year = Number(rawYear);
  const viewer = context.get("viewer");
  const today = todayKst();
  const dataVersion = await getDataVersion(context.env.DB);
  const response = await getOrCacheJson(
    context.req.raw,
    dataVersion,
    viewer.viewingAs,
    async () => {
      const replies = await getReplyVisibility(context.env.DB);
      const [rows, allTags, otherEnabled] = await Promise.all([
        getMonthCounts(context.env.DB, year, viewer, replies),
        visibleTags(context.env.DB, viewer),
        isOtherTopicEnabled(context.env.DB),
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
      if (otherEnabled) {
        for (const row of await getOtherCounts(context.env.DB, "month", viewer, replies, year)) {
          months[Number(row.period) - 1].counts[OTHER_TOPIC_ID] = row.other_count;
        }
      }
      const firstDate = `${rawYear}-01-01`;
      const lastDate = `${rawYear}-12-31`;
      const tags = allTags.filter((tag) => tag.start_date <= lastDate
        && (tag.end_date ?? today) >= firstDate);
      return { year, months, tags };
    },
    today,
    context.env.CF_VERSION_METADATA?.id,
  );
  return context.json(response);
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
  const viewer = context.get("viewer");
  const dataVersion = await getDataVersion(context.env.DB);
  const response = await getOrCacheJson(
    context.req.raw,
    dataVersion,
    viewer.viewingAs,
    async () => {
      const replies = await getReplyVisibility(context.env.DB);
      const [rows, otherEnabled] = await Promise.all([
        getCalendarCounts(context.env.DB, year, month, viewer, replies),
        isOtherTopicEnabled(context.env.DB),
      ]);
      const days = new Map<string, { date: string; total: number; top_topic: string | null }>();
      for (const row of rows) {
        let day = days.get(row.date);
        if (!day) {
          day = { date: row.date, total: row.total, top_topic: row.topic_id };
          days.set(row.date, day);
        }
        if (day.top_topic === null && row.topic_id !== null) day.top_topic = row.topic_id;
      }
      if (otherEnabled) {
        for (const row of await getOtherCounts(context.env.DB, "date_kst", viewer, replies, year, month)) {
          const day = days.get(String(row.period))!;
          if (day.top_topic === null) day.top_topic = OTHER_TOPIC_ID;
        }
      }
      return { year, month, days: [...days.values()] };
    },
    `${year}-${month}`,
    context.env.CF_VERSION_METADATA?.id,
  );
  return context.json(response);
});

export default route;
