import { DateTime } from "luxon";
import type { SegmentLike, Totals } from "./accounting.js";
import { totalsForPeriod } from "./accounting.js";

export function tallinnDateRange(startDate: string, endDate: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(startDate, { zone: timezone }).startOf("day");
  const inclusiveEnd = DateTime.fromISO(endDate, { zone: timezone }).startOf("day");
  if (!start.isValid || !inclusiveEnd.isValid || inclusiveEnd < start) throw new Error("Invalid date range");
  return { start: start.toUTC().toJSDate(), end: inclusiveEnd.plus({ days: 1 }).toUTC().toJSDate() };
}

export function calendarYearRange(now: Date, timezone: string): { start: Date; end: Date } {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  return {
    start: local.startOf("year").toUTC().toJSDate(),
    end: local.plus({ years: 1 }).startOf("year").toUTC().toJSDate(),
  };
}

export type LeaderboardRow = { identityId: string; username: string; totals: Totals };

export function buildLeaderboard(
  rows: Array<{ identityId: string; username: string; segments: SegmentLike[] }>,
  start: Date,
  end: Date,
  minimumMs = 0,
): LeaderboardRow[] {
  return rows
    .map((row) => ({ ...row, totals: totalsForPeriod(row.segments, start, end) }))
    .filter((row) => row.totals.totalMs >= minimumMs)
    .sort((a, b) => b.totals.totalMs - a.totals.totalMs || a.username.localeCompare(b.username));
}

