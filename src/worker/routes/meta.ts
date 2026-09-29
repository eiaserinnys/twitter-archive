import { Hono } from "hono";
import { TOPIC_SEED } from "../../shared/topics.js";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { getLastCollectedAt, getTweetStats } from "../db/meta.js";
import { listTopicInfo } from "../db/topics.js";
import type { AppContext } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.get("/api/meta", async (context: AppContext) => {
  const [stats, lastCollectedAt, topics] = await Promise.all([
    getTweetStats(context.env.DB),
    getLastCollectedAt(context.env.DB),
    listTopicInfo(context.env.DB, context.get("viewer")),
  ]);
  const response = {
    site_title: context.env.SITE_TITLE,
    account_handle: context.env.ACCOUNT_HANDLE,
    total_tweets: stats.total_tweets,
    first_date: stats.first_date,
    last_date: stats.last_date,
    last_collected_at: lastCollectedAt,
    thresholds: {
      display: TOPIC_SEED.display_threshold,
      search: TOPIC_SEED.search_threshold,
    },
    topics,
  };
  if (context.get("viewer").viewingAs !== "owner") return context.json(response);
  const batchSize = Number(context.env.SCORE_BATCH);
  return context.json({
    ...response,
    rescore_estimate: {
      tweets: stats.total_tweets,
      est_usd: stats.total_tweets * 400 * 0.042 / 1_000_000,
      est_minutes: Math.ceil(stats.total_tweets / batchSize),
    },
  });
});

export default route;
