import { DateTime } from "luxon";
import { userError } from "../../../core/errors.js";

/**
 * The add/edit session form, as typed. Discord has no date picker, so the day
 * comes from a menu of recent days and the times are short free-text boxes that
 * accept every common way of writing a time or a duration.
 */
export type SessionFormInput = {
  /** ISO date of the day the session started, picked from {@link dayChoices}. */
  date: string;
  start: string;
  end: string;
  /** Empty means none. */
  inactive: string;
  note: string;
};

export type ManualSession = { start: Date; end: Date; activeMs: number; inactiveMs: number };

/** Discord allows 25 options in a select menu. */
export const DAY_CHOICE_LIMIT = 25;

/** A day in the form's date menu. */
export type DayChoice = { value: string; label: string };

/**
 * The days a session can be entered for: today and the 24 before it, newest
 * first. A day outside that window that the form must still show — the date of
 * a session being edited — takes the last slot.
 */
export function dayChoices(now: Date, timezone: string, include?: string): DayChoice[] {
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf("day");
  const days = Array.from({ length: DAY_CHOICE_LIMIT }, (_, back) => today.minus({ days: back }));
  if (include && !days.some((day) => day.toISODate() === include)) {
    const extra = DateTime.fromISO(include, { zone: timezone });
    if (extra.isValid) days[DAY_CHOICE_LIMIT - 1] = extra;
  }
  return days.map((day) => {
    const back = Math.round(today.diff(day.startOf("day"), "days").days);
    const name = day.toFormat(day.year === today.year ? "ccc, LLL d" : "ccc, LLL d, yyyy");
    const label = back === 0 ? `Today · ${name}` : back === 1 ? `Yesterday · ${name}` : name;
    return { value: day.toISODate()!, label };
  });
}

/**
 * A time of day: `14:30`, `14.30`, `1430`, `14`, `2:30pm`, `2 pm`. Returns
 * minutes after midnight.
 */
export function parseClockTime(value: string, field: string): number {
  const input = value.trim().toLowerCase().replace(/\s+/g, "");
  const match = input.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm)?$/);
  let hour = Number(match?.[1]);
  const minute = Number(match?.[2] ?? 0);
  const meridiem = match?.[3];
  if (meridiem && (hour < 1 || hour > 12)) hour = Number.NaN;
  else if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  if (!match || !(hour >= 0 && hour < 24) || minute >= 60) {
    userError(`${field} "${value.trim()}" isn't a time. Write it like 14:30.`);
  }
  return hour * 60 + minute;
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * A length of time: `2h 15m`, `1h`, `45m`, `45` (minutes), `1:05` (h:mm),
 * `2 hours 5 min`. Empty is zero.
 */
export function parseFlexibleDuration(value: string, field: string): number {
  const input = value.trim().toLowerCase();
  if (!input) return 0;
  if (/^\d+$/.test(input)) return Number(input) * 60_000;
  const clock = input.match(/^(\d+):([0-5]\d)$/);
  if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 60_000;
  const parts = [...input.matchAll(/(\d+)\s*(h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?![a-z])/g)];
  const consumed = parts.map((part) => part[0]).join("").replace(/\s+/g, "");
  if (!parts.length || consumed !== input.replace(/\s+/g, "")) {
    userError(`${field} "${value.trim()}" isn't a length of time. Write it like 1h 10m, or leave it empty.`);
  }
  return parts.reduce((sum, part) => sum + Number(part[1]) * UNIT_MS[part[2]![0]!]!, 0);
}

/** The form's times as they would be typed back in. */
export function clockTime(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("HH:mm");
}

export function localDate(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toISODate()!;
}

/** A duration as the form accepts it back: `1h 5m`, `45m`, or empty for none. */
export function formDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours}h` : "", rest ? `${rest}m` : ""].filter(Boolean).join(" ");
}

/**
 * Turns the form into a session. Active time is whatever the inactive time and
 * any old reconnecting time leave of the session's length, so the parts always
 * add up and nobody has to do that sum by hand. An end time earlier than the
 * start means the session ran past midnight.
 */
export function buildManualSession(
  input: SessionFormInput,
  timezone: string,
  now: Date,
  reconnectMs = 0,
): ManualSession {
  const day = DateTime.fromISO(input.date, { zone: timezone });
  if (!day.isValid) userError("Pick the day the session started");
  const startMinutes = parseClockTime(input.start, "Start time");
  const endMinutes = parseClockTime(input.end, "End time");
  const inactiveMs = parseFlexibleDuration(input.inactive, "Inactive time");

  const start = day.set({ hour: Math.floor(startMinutes / 60), minute: startMinutes % 60 });
  let end = day.set({ hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 });
  if (end.equals(start)) userError("Start and end are the same time.");
  if (end < start) end = end.plus({ days: 1 });

  const lengthMs = end.toMillis() - start.toMillis();
  if (end.toMillis() > now.getTime()) userError("That session ends in the future. Check the date and the end time.");
  const activeMs = lengthMs - inactiveMs - reconnectMs;
  if (activeMs < 0) {
    userError(`Inactive time (${formDuration(inactiveMs)}) is longer than the session itself (${formDuration(lengthMs - reconnectMs) || "under a minute"}).`);
  }
  return { start: start.toJSDate(), end: end.toJSDate(), activeMs, inactiveMs };
}
