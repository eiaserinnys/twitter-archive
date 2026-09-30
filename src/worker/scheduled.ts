import type { Env, ScheduledEvent, WorkerExecutionContext } from "./env.js";
import { collectNewTweets } from "./collect/index.js";
import { backfillArticles } from "./collect/articles.js";
import { processRescoreJobs, scoreCollectedTweets, scorePendingTweets } from "./score-queue.js";

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: WorkerExecutionContext,
): Promise<void> {
  if (event.cron === "*/30 * * * *") {
    const retried = await scorePendingTweets(env);
    const tweetIds = await collectNewTweets(env);
    const articleIds = await backfillArticles(env);
    const scoringIds = [...new Set([...tweetIds, ...articleIds])];
    const collected = scoringIds.length === 0
      ? { scored: 0, stoppedForBudget: false }
      : await scoreCollectedTweets(env, scoringIds);
    const stoppedForBudget = retried.stoppedForBudget || collected.stoppedForBudget;
    console.log(`Collected ${tweetIds.length} new tweets; retried ${retried.scored}; scored ${collected.scored} tweets${stoppedForBudget ? "; stopped at monthly cap" : ""}.`);
    return;
  }
  if (event.cron === "* * * * *") {
    const result = await processRescoreJobs(env);
    console.log(`Rescored ${result.scored} tweets${result.stoppedForBudget ? "; stopped at monthly cap" : ""}.`);
  }
}
