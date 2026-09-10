import { DateTime } from "luxon";
import type { SegmentLike } from "./accounting.js";
import { totalsForPeriod } from "./accounting.js";

export const MINIMUM_SESSION_MILLISECONDS = 60_000;
export const SESSION_RETENTION_YEARS = 1;

/**
 * How long a staff-chat announcement stays up once its shift is over. The
 * announcement is a notification, not a record — the logs channel keeps the
 * permanent copy — so it is taken down shortly after the shift settles instead
 * of accumulating in the channel staff actually talk in.
 */
export const ANNOUNCEMENT_RETENTION_MILLISECONDS = 5 * 60_000;

/** A session's announcement only counts the shift's own outcome, never a later edit. */
export type AnnouncementTimingLike = {
  endedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * The instant a shift's announcement stopped changing: when the shift ended,
 * or when a still-running shift was removed. `null` while it is still live.
 */
export function announcementSettledAt(session: AnnouncementTimingLike): Date | null {
  return session.endedAt ?? session.deletedAt;
}

/** Announcements settled at or before this instant are due to be taken down. */
export function announcementRetentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - ANNOUNCEMENT_RETENTION_MILLISECONDS);
}

/**
 * True once a settled announcement has outlived its retention. The publisher
 * checks this too, so a refresh cannot repost an announcement the cleanup has
 * already taken down.
 */
export function announcementRetentionElapsed(session: AnnouncementTimingLike, now = new Date()): boolean {
  const settledAt = announcementSettledAt(session);
  return settledAt !== null && settledAt.getTime() <= announcementRetentionCutoff(now).getTime();
}

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
