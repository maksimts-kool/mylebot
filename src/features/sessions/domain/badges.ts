import { DateTime } from "luxon";
import { sessionRetentionCutoff } from "./policy.js";

/**
 * The badge catalogue and the rules for earning each badge. Everything here is
 * pure, so the awarding job, the profile card and the `/badges` guide all read
 * the same definitions and cannot drift apart.
 *
 * Every badge counts from the member's first tracked shift: hours and months
 * from before badges existed count the same as any since.
 */

export type BadgeGroup = "hours" | "leaderboard" | "special";

/** The picture drawn inside a badge. The artwork itself lives with the renderer. */
export type BadgeIcon =
  | "rank-1" | "rank-2" | "rank-3" | "rank-star" | "rank-stars"
  | "month-star" | "lift-podium" | "lift-shield";

export type BadgeDefinition = {
  key: string;
  name: string;
  group: BadgeGroup;
  /** How to earn it, as one sentence for the guide. */
  howToEarn: string;
  emoji: string;
  /** Repeatable badges are earned once per calendar month and shown as ×N. */
  repeatable: boolean;
  /** Fill and glyph colour on the card, as `#rrggbb`. */
  color: { fill: string; glyph: string };
  icon: BadgeIcon;
  /** Hours badges only: the active time they need. */
  thresholdMs?: number;
};

const HOUR_MS = 3_600_000;

function hoursBadge(hours: number, emoji: string, icon: BadgeIcon, color: BadgeDefinition["color"]): BadgeDefinition {
  return {
    key: `hours-${hours}`,
    name: `${hours} hours`,
    group: "hours",
    howToEarn: `Spend ${hours} hours of active time on shift.`,
    emoji,
    repeatable: false,
    color,
    icon,
    thresholdMs: hours * HOUR_MS,
  };
}

export const BADGES: readonly BadgeDefinition[] = [
  hoursBadge(10, "🔸", "rank-1", { fill: "#2e4d3b", glyph: "#6ee7a0" }),
  hoursBadge(50, "🔶", "rank-2", { fill: "#2e4552", glyph: "#7cc9ef" }),
  hoursBadge(150, "🎗️", "rank-3", { fill: "#55332a", glyph: "#f6a37f" }),
  hoursBadge(500, "⭐", "rank-star", { fill: "#2f3d5c", glyph: "#93b4f8" }),
  hoursBadge(1000, "🌟", "rank-stars", { fill: "#2f4f52", glyph: "#7fe3e0" }),
  {
    key: "monthly-first",
    name: "Staff of the month",
    group: "leaderboard",
    howToEarn: "Finish a calendar month #1 on /leaderboard. Can be earned again.",
    emoji: "🏆",
    repeatable: true,
    color: { fill: "#4d3f22", glyph: "#f5c869" },
    icon: "month-star",
  },
  {
    key: "monthly-top3",
    name: "Top 3",
    group: "leaderboard",
    howToEarn: "Finish a calendar month in the top 3 on /leaderboard. Can be earned again.",
    emoji: "🏅",
    repeatable: true,
    color: { fill: "#46303f", glyph: "#f0a3cf" },
    icon: "lift-podium",
  },
  {
    key: "veteran",
    name: "Veteran",
    group: "special",
    howToEarn: "Be on the team for one year, counted from your first tracked shift.",
    emoji: "🛡️",
    repeatable: false,
    color: { fill: "#3a3456", glyph: "#b9b0f5" },
    icon: "lift-shield",
  },
];

export const BADGE_GROUPS: ReadonlyArray<{ group: BadgeGroup; title: string; emoji: string }> = [
  { group: "hours", title: "Hours on shift", emoji: "⏱️" },
  { group: "leaderboard", title: "Leaderboard", emoji: "🏆" },
  { group: "special", title: "Special", emoji: "✨" },
];

export const HOURS_BADGES = BADGES.filter((badge): badge is BadgeDefinition & { thresholdMs: number } => badge.thresholdMs !== undefined);

export function badgeByKey(key: string): BadgeDefinition | undefined {
  return BADGES.find((badge) => badge.key === key);
}

/** How long a member must have been tracked before Veteran is due. */
export const VETERAN_YEARS = 1;

/**
 * How long after a month ends before its leaderboard is settled. Shifts still
 * running at midnight are closed by the sweep shortly after, and ranking a
 * month before then could hand a badge to the wrong person.
 */
export const MONTH_SETTLE_MILLISECONDS = 60 * 60_000;

/** Hours badges an amount of active time qualifies for, smallest first. */
export function hoursBadgesEarned(activeMs: number): string[] {
  return HOURS_BADGES.filter((badge) => activeMs >= badge.thresholdMs).map((badge) => badge.key);
}

/** The next hours badge still to earn, or null once every one is held. */
export function nextHoursBadge(activeMs: number): (BadgeDefinition & { thresholdMs: number }) | null {
  return HOURS_BADGES.find((badge) => activeMs < badge.thresholdMs) ?? null;
}

export function veteranDue(firstTrackedAt: Date, now: Date): boolean {
  return DateTime.fromJSDate(firstTrackedAt).plus({ years: VETERAN_YEARS }) <= DateTime.fromJSDate(now);
}

/** When Veteran becomes due for someone first tracked at `firstTrackedAt`. */
export function veteranDueAt(firstTrackedAt: Date): Date {
  return DateTime.fromJSDate(firstTrackedAt).plus({ years: VETERAN_YEARS }).toJSDate();
}

/**
 * Leaderboard badges for one finished month, given the month's ranking best
 * first. First place earns both badges: finishing first is finishing top 3.
 */
export function monthlyAwards<T>(ranking: readonly T[]): Array<{ member: T; badge: string }> {
  const awards: Array<{ member: T; badge: string }> = [];
  ranking.slice(0, 3).forEach((member, index) => {
    if (index === 0) awards.push({ member, badge: "monthly-first" });
    awards.push({ member, badge: "monthly-top3" });
  });
  return awards;
}

/** The half-open instant range of a `yyyy-LL` month in the report timezone. */
export function monthRange(month: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromFormat(month, "yyyy-LL", { zone: timezone });
  if (!start.isValid) throw new Error(`Invalid month: ${month}`);
  return { start: start.toUTC().toJSDate(), end: start.plus({ months: 1 }).toUTC().toJSDate() };
}

/** `December 2026`, for the DM that announces a month's badge. */
export function monthLabel(month: string, timezone: string): string {
  return DateTime.fromFormat(month, "yyyy-LL", { zone: timezone }).toFormat("LLLL yyyy");
}

/**
 * Months whose leaderboard badges are due, oldest first, starting with the
 * month of the first tracked shift: that month is ranked on everything the
 * tracker saw in it, as `/leaderboard` would rank it. A month is only due once
 * it has ended and settled, and months up to `awardedThrough` were handed out
 * already.
 *
 * Retention deletes sessions after a year, so a month it has started eating
 * into would rank people on part of their time. Ranking starts no earlier than
 * the first whole month retention still holds; in practice that only matters
 * if ranking begins more than a year after the first shift.
 */
export function monthsToAward(
  firstShiftAt: Date | null,
  awardedThrough: string | null,
  now: Date,
  timezone: string,
  settleMs = MONTH_SETTLE_MILLISECONDS,
): string[] {
  if (!firstShiftAt) return [];
  let month = DateTime.fromJSDate(firstShiftAt, { zone: timezone }).startOf("month");
  const retained = DateTime.fromJSDate(sessionRetentionCutoff(now), { zone: timezone });
  if (month < retained) {
    month = retained.startOf("month");
    if (month < retained) month = month.plus({ months: 1 });
  }
  if (awardedThrough) {
    const after = DateTime.fromFormat(awardedThrough, "yyyy-LL", { zone: timezone }).plus({ months: 1 });
    if (after.isValid && after > month) month = after;
  }
  const due: string[] = [];
  const settledBefore = now.getTime() - settleMs;
  while (month.plus({ months: 1 }).toMillis() <= settledBefore) {
    due.push(month.toFormat("yyyy-LL"));
    month = month.plus({ months: 1 });
  }
  return due;
}

/** What a member holds of one badge. */
export type HeldBadge = { count: number; firstAwardedAt: Date; lastPeriod: string };

/** Folds award rows into one entry per badge held. */
export function heldBadges(awards: ReadonlyArray<{ badge: string; period: string; awardedAt: Date }>): Map<string, HeldBadge> {
  const held = new Map<string, HeldBadge>();
  for (const award of awards) {
    const current = held.get(award.badge);
    if (!current) {
      held.set(award.badge, { count: 1, firstAwardedAt: award.awardedAt, lastPeriod: award.period });
      continue;
    }
    current.count += 1;
    if (award.awardedAt < current.firstAwardedAt) current.firstAwardedAt = award.awardedAt;
    if (award.period > current.lastPeriod) current.lastPeriod = award.period;
  }
  return held;
}
