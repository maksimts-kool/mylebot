import { DateTime } from "luxon";
import type { SegmentLike } from "./accounting.js";
import { totalsForPeriod } from "./accounting.js";

export const MINIMUM_SESSION_MILLISECONDS = 60_000;
export const SESSION_RETENTION_YEARS = 1;

export type SessionTimingLike = {
  startedAt: Date;
  endedAt: Date | null;
  segments: SegmentLike[];
};

export function recordedTimeMeetsSessionMinimum(active: number | bigint, inactive: number | bigint): boolean {
  return BigInt(active) + BigInt(inactive) >= BigInt(MINIMUM_SESSION_MILLISECONDS);
}

export function sessionMeetsMinimum(session: SessionTimingLike, now = new Date()): boolean {
  const end = session.endedAt ?? now;
  return totalsForPeriod(session.segments, session.startedAt, end, end).totalMs >= MINIMUM_SESSION_MILLISECONDS;
}

export function sessionRetentionCutoff(now = new Date()): Date {
  return DateTime.fromJSDate(now).minus({ years: SESSION_RETENTION_YEARS }).toJSDate();
}
