import { DateTime } from "luxon";
import { totalsForPeriod } from "./accounting.js";
import { sessionMeetsMinimum, type SessionTimingLike } from "./policy.js";

/**
 * The shift figures a profile shows. Sessions are kept for a year, so the
 * long-range figure is the past twelve months rather than an "all-time" total
 * the bot could not honestly give. Times match `/leaderboard`: active plus
 * inactive.
 */
export type ProfileStats = {
  yearMs: number;
  monthMs: number;
  shifts: number;
  averageMs: number;
  /** `null` while a shift is running right now. */
  lastShiftEndedAt: Date | null;
  onShift: boolean;
};

export type ProfileSession = SessionTimingLike & { deletedAt: Date | null };

export function profileStats(sessions: readonly ProfileSession[], now: Date, timezone: string): ProfileStats | null {
  const yearStart = DateTime.fromJSDate(now).minus({ years: 1 }).toJSDate();
  const monthStart = DateTime.fromJSDate(now, { zone: timezone }).startOf("month").toUTC().toJSDate();
  const counted = sessions.filter((session) => session.deletedAt === null && sessionMeetsMinimum(session, now));
  if (!counted.length) return null;

  let yearMs = 0;
  let monthMs = 0;
  let shifts = 0;
  let onShift = false;
  let lastShiftEndedAt: Date | null = null;
  for (const session of counted) {
    const year = totalsForPeriod(session.segments, yearStart, now, now).totalMs;
    if (year > 0) {
      yearMs += year;
      shifts += 1;
    }
    monthMs += totalsForPeriod(session.segments, monthStart, now, now).totalMs;
    if (session.endedAt === null) onShift = true;
    else if (!lastShiftEndedAt || session.endedAt > lastShiftEndedAt) lastShiftEndedAt = session.endedAt;
  }
  if (!shifts) return null;
  return { yearMs, monthMs, shifts, averageMs: Math.round(yearMs / shifts), lastShiftEndedAt: onShift ? null : lastShiftEndedAt, onShift };
}

/** `186h`, `1h 19m`, `45m` — short enough for a stat tile. */
export function compactDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours >= 10) return `${hours}h`;
  if (hours > 0) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  return `${minutes}m`;
}

/** `On shift now`, `Today`, `Yesterday`, `5 days ago`, or a date past a month. */
export function lastSeenLabel(stats: ProfileStats, now: Date, timezone: string): string {
  if (stats.onShift) return "On shift now";
  if (!stats.lastShiftEndedAt) return "—";
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const ended = DateTime.fromJSDate(stats.lastShiftEndedAt, { zone: timezone });
  const days = Math.round(today.diff(ended.startOf("day"), "days").days);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 31) return `${days} days ago`;
  return ended.toFormat("LLL d, yyyy");
}
