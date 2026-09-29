import { Hono } from "hono";
import { TOPIC_SEED } from "../../shared/topics.js";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { getCacheMeta, getPublicHiddenCount, getTweetStats } from "../db/meta.js";
import { listTopicInfo } from "../db/topics.js";
import type { AppContext } from "./helpers.js";
import { getOrCacheJson } from "../cache.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.get("/api/meta", async (context: AppContext) => {
  const viewer = context.get("viewer");
  const cacheMeta = await getCacheMeta(context.env.DB);
  const response = await getOrCacheJson(
    context.req.raw,
    cacheMeta.data_version,
    viewer.viewingAs,
    async () => {
      const [stats, topics] = await Promise.all([
        getTweetStats(context.env.DB, viewer),
        listTopicInfo(context.env.DB, viewer),
      ]);
      const body = {
        site_title: context.env.SITE_TITLE,
        account_handle: context.env.ACCOUNT_HANDLE,
        source_url: context.env.SOURCE_URL || null,
        total_tweets: stats.total_tweets,
        first_date: stats.first_date,
        last_date: stats.last_date,
        thresholds: {
          display: TOPIC_SEED.display_threshold,
          search: TOPIC_SEED.search_threshold,
        },
        topics,
      };
      if (viewer.viewingAs !== "owner") return body;
      const publicHiddenCount = await getPublicHiddenCount(context.env.DB);
      const batchSize = Number(context.env.SCORE_BATCH);
      return {
        ...body,
        public_hidden_count: publicHiddenCount,
        rescore_estimate: {
          tweets: stats.total_tweets,
          est_usd: stats.total_tweets * 400 * 0.042 / 1_000_000,
          est_minutes: Math.ceil(stats.total_tweets / batchSize),
        },
      };
    },
    undefined,
    context.env.CF_VERSION_METADATA?.id,
  );
  return context.json({ ...response, last_collected_at: cacheMeta.last_collected_at });
});

export default route;
