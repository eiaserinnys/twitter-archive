import type { ScheduledEvent } from "../worker/env.js";

export function cronInterval(cron: string): number {
  const match = /^(\*|\*\/([1-9]\d*)) \* \* \* \*$/.exec(cron);
  if (!match) throw new Error("Unsupported cron: " + cron);
  return match[2] ? Number(match[2]) : 1;
}
export function cronMatches(interval: number, time: number): boolean {
  return new Date(time).getUTCMinutes() % interval === 0;
}
export function startScheduler(crons: string[], run: (event: ScheduledEvent) => Promise<void>): () => void {
  const schedules = crons.map((cron) => ({ cron, interval: cronInterval(cron) }));
  const running = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    timer = setTimeout(() => {
      const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;
      for (const { cron, interval } of schedules) {
        if (!cronMatches(interval, scheduledTime)) continue;
        if (running.has(cron)) { console.log("Scheduled skip (still running): " + cron); continue; }
        running.add(cron);
        console.log("Scheduled: " + cron + " at " + new Date(scheduledTime).toISOString());
        Promise.resolve().then(() => run({ cron, scheduledTime })).catch((error: unknown) => console.error("Scheduled failed:", error))
          .finally(() => running.delete(cron));
      }
      if (!stopped) schedule();
    }, 60_000 - Date.now() % 60_000);
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
