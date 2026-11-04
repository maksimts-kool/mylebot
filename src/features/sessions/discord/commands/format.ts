import { DateTime } from "luxon";

export function formatSessionDateTime(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("dd/LL/yyyy HH:mm");
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
  if (start.year === end.year) return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d, yyyy")}`;
  return `${start.toFormat("LLL d, yyyy")} – ${end.toFormat("LLL d, yyyy")}`;
}
