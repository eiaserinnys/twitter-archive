import type { Env, ScheduledEvent, WorkerExecutionContext } from "./env.js";

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: WorkerExecutionContext,
): Promise<void> {}
