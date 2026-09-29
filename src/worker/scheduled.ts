import type { Env, ScheduledEvent, WorkerExecutionContext } from "./env.js";
import { collectNewTweets } from "./collect/index.js";
import { scorePendingTweets } from "./score-queue.js";

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: WorkerExecutionContext,
): Promise<void> {
  if (event.cron === "*/30 * * * *") {
    const collected = await collectNewTweets(env);
    console.log(`Collected ${collected} new tweets.`);
    return;
  }
  if (event.cron === "* * * * *") {
    const result = await scorePendingTweets(env);
    console.log(`Scored ${result.scored} tweets${result.stoppedForBudget ? "; stopped at monthly cap" : ""}.`);
  }
}
