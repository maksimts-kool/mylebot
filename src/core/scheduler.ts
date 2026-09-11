import { errorType } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * What a run has to say for itself. A job that returns nothing did nothing
 * worth reading about, and stays silent at `info` — most ticks of a sweep or a
 * poll are exactly that. Anything a job does return is appended to its name,
 * so phrase it as a verb: `"ended 2 stale sessions"`.
 */
export type JobOutcome = string | undefined | void;

export type ScheduledJob = {
  name: string;
  intervalMs: number;
  run: () => Promise<JobOutcome>;
};

/**
 * Runs jobs on fixed intervals. The next run is only armed once the previous one
 * settles, so a slow job can never overlap itself — it just logs that it
 * exceeded its interval.
 */
export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private stopping = false;

  constructor(private readonly log: Logger) {}

  register(job: ScheduledJob): void {
    const timer: NodeJS.Timeout = setTimeout(async () => {
      if (this.stopping) return;
      const startedAt = Date.now();
      try {
        const outcome = await job.run();
        const durationMs = Date.now() - startedAt;
        if (outcome) this.log.info({ category: "job", durationMs }, `${job.name} ${outcome}`);
        else this.log.debug({ category: "job", durationMs }, `${job.name} completed`);
      } catch (error) {
        this.log.error({ category: "job", err: error, errorType: errorType(error), durationMs: Date.now() - startedAt }, `${job.name} failed`);
      } finally {
        if (!this.stopping) timer.refresh();
        const durationMs = Date.now() - startedAt;
        if (durationMs > job.intervalMs) this.log.warn({ category: "job", durationMs, intervalMs: job.intervalMs }, `${job.name} ran longer than its interval`);
      }
    }, job.intervalMs);
    this.timers.push(timer);
    this.log.debug({ category: "job", intervalMs: job.intervalMs }, `${job.name} registered`);
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }
}
