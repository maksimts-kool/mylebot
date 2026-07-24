import { DateTime } from "luxon";

export function parseSessionDateTime(value: string, timezone: string): Date {
  const input = value.trim();
  const iso = DateTime.fromISO(input, { setZone: true });
  if (iso.isValid) return iso.toJSDate();

  for (const format of ["d/M/yyyy H:mm", "d.M.yyyy H:mm", "d-M-yyyy H:mm", "yyyy-MM-dd H:mm"]) {
    const local = DateTime.fromFormat(input, format, { zone: timezone });
    if (local.isValid) return local.toJSDate();
  }
  throw new Error("Invalid date and time. Use 11/07/2026 14:30 (your reporting time zone).");
}

export function formatSessionDateTime(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("dd/LL/yyyy HH:mm");
}

export function parseDuration(value: string): number {
  const clock = value.trim().match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (clock) return ((Number(clock[1]) * 3600) + (Number(clock[2]) * 60) + Number(clock[3] ?? 0)) * 1000;
  const match = value.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (!match || !match[0].trim() || (!match[1] && !match[2] && !match[3])) throw new Error(`Invalid duration: ${value}`);
  return ((Number(match[1] ?? 0) * 3600) + (Number(match[2] ?? 0) * 60) + Number(match[3] ?? 0)) * 1000;
}

export function friendlyDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainder = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (remainder && parts.length < 2) parts.push(`${remainder} ${remainder === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

export function friendlyPeriod(startDate: string, endDate: string, timezone: string): string {
  const start = DateTime.fromISO(startDate, { zone: timezone });
  const end = DateTime.fromISO(endDate, { zone: timezone });
  const coversFullMonth = start.hasSame(end, "month") && start.day === 1 && end.day === end.daysInMonth;
  if (coversFullMonth) return start.toFormat("LLLL yyyy");
  if (start.year === end.year) return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d, yyyy")}`;
  return `${start.toFormat("LLL d, yyyy")} – ${end.toFormat("LLL d, yyyy")}`;
}
