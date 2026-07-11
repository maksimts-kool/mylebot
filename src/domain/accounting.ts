import type { SessionState } from "@prisma/client";

export type Totals = { activeMs: number; inactiveMs: number; totalMs: number };
export type SegmentLike = { state: SessionState; startedAt: Date; endedAt: Date | null };

export function overlapMilliseconds(start: Date, end: Date, periodStart: Date, periodEnd: Date): number {
  return Math.max(0, Math.min(end.getTime(), periodEnd.getTime()) - Math.max(start.getTime(), periodStart.getTime()));
}

export function totalsForPeriod(
  segments: SegmentLike[],
  periodStart: Date,
  periodEnd: Date,
  now = new Date(),
): Totals {
  let activeMs = 0;
  let inactiveMs = 0;
  for (const segment of segments) {
    const milliseconds = overlapMilliseconds(segment.startedAt, segment.endedAt ?? now, periodStart, periodEnd);
    if (segment.state === "ACTIVE") activeMs += milliseconds;
    if (segment.state === "INACTIVE") inactiveMs += milliseconds;
  }
  return { activeMs, inactiveMs, totalMs: activeMs + inactiveMs };
}

export function formatDuration(milliseconds: number | bigint): string {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${minutes}m ${remainder}s`;
}

export function assertDurationInvariant(start: Date, end: Date, activeMs: number, inactiveMs: number): void {
  const total = end.getTime() - start.getTime();
  if (total < 0 || activeMs < 0 || inactiveMs < 0 || activeMs + inactiveMs !== total) {
    throw new Error("Active plus inactive time must equal the session duration");
  }
}
