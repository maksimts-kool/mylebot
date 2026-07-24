import type { FastifyBaseLogger } from "fastify";
import { errorType } from "./errors.js";

export type ScheduledJob = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

/**
 * Runs jobs on fixed intervals. The next run is only armed once the previous one
 * settles, so a slow job can never overlap itself — it just logs that it
 * exceeded its interval.
 */
export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private stopping = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  register(job: ScheduledJob): void {
    const timer: NodeJS.Timeout = setTimeout(async () => {
      if (this.stopping) return;
      const startedAt = Date.now();
      try {
        await job.run();
        this.log.info({ job: job.name, durationMs: Date.now() - startedAt }, "Scheduled job completed");
      } catch (error) {
        this.log.error({ job: job.name, errorType: errorType(error), durationMs: Date.now() - startedAt }, "Scheduled job failed");
      } finally {
        if (!this.stopping) timer.refresh();
        const duration = Date.now() - startedAt;
        if (duration > job.intervalMs) this.log.warn({ job: job.name, durationMs: duration, intervalMs: job.intervalMs }, "Scheduled job exceeded its interval");
      }
    }, job.intervalMs);
    this.timers.push(timer);
    this.log.info({ job: job.name, intervalMs: job.intervalMs }, "Scheduled job registered");
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }
}
