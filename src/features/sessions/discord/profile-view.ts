import { DateTime } from "luxon";
import {
  BADGE_GROUPS, BADGES, heldBadges, monthLabel, nextHoursBadge, veteranDueAt, type BadgeDefinition, type HeldBadge,
} from "../domain/badges.js";
import { compactDuration, lastSeenLabel, type ProfileStats } from "../domain/profile.js";
import type { ProfileCardModel } from "./profile-card.js";

/**
 * What the profile card and the `/badges` guide say, decided without Discord or
 * a canvas so it can be tested as plain data.
 */

const HOUR_MS = 3_600_000;

export type BadgeStandingView = {
  launchedAt: Date;
  activeMs: number;
  firstTrackedAt: Date | null;
  awards: ReadonlyArray<{ badge: string; period: string; awardedAt: Date }>;
};

function wholeHours(milliseconds: number): string {
  return `${Math.floor(milliseconds / HOUR_MS)}h`;
}

function launchMonth(launchedAt: Date, timezone: string): string {
  return DateTime.fromJSDate(launchedAt, { zone: timezone }).toFormat("LLL yyyy");
}

export function profileCardModel(input: {
  robloxUsername: string;
  discordName: string | null;
  rank: string | null;
  avatar: Buffer | null;
  stats: ProfileStats | null;
  standing: BadgeStandingView;
  now: Date;
  timezone: string;
}): ProfileCardModel {
  const { stats, standing, now, timezone } = input;
  const held = heldBadges(standing.awards);
  const next = nextHoursBadge(standing.activeMs);
  const dash = "—";
  return {
    title: input.robloxUsername,
    subtitle: input.discordName ? `@${input.discordName} · Discord` : null,
    rank: input.rank,
    avatar: input.avatar,
    onShift: stats?.onShift ?? false,
    tiles: [
      { label: "Past 12 months", value: stats ? compactDuration(stats.yearMs) : dash },
      { label: "This month", value: stats ? compactDuration(stats.monthMs) : dash },
      { label: "Shifts", value: stats ? String(stats.shifts) : dash },
      { label: "Avg shift", value: stats ? compactDuration(stats.averageMs) : dash },
      { label: "Last on shift", value: stats ? lastSeenLabel(stats, now, timezone) : dash },
    ],
    badges: BADGES.map((badge) => ({
      name: badge.name,
      color: badge.color,
      icon: badge.icon,
      repeatable: badge.repeatable,
      earned: held.has(badge.key),
      count: held.get(badge.key)?.count ?? 0,
    })),
    badgeSummary: `${held.size} of ${BADGES.length}`,
    sinceLabel: `Since launch · ${launchMonth(standing.launchedAt, timezone)}`,
    next: next
      ? {
        label: `Next: ${next.name}`,
        progressLabel: `${wholeHours(standing.activeMs)} / ${wholeHours(next.thresholdMs)}`,
        fraction: standing.activeMs / next.thresholdMs,
      }
      : { label: "Every hours badge earned", progressLabel: wholeHours(standing.activeMs), fraction: 1 },
  };
}

/** `▰▰▰▰▱▱▱▱▱▱` — ten steps, so the guide reads at a glance. */
export function progressBar(fraction: number, steps = 10): string {
  const filled = Math.min(steps, Math.max(0, Math.floor(fraction * steps)));
  return "▰".repeat(filled) + "▱".repeat(steps - filled);
}

function shortDate(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat("LLL d, yyyy");
}

function statusLine(badge: BadgeDefinition, held: HeldBadge | undefined, standing: BadgeStandingView, now: Date, timezone: string): string {
  if (held) {
    return badge.repeatable
      ? `✅ Earned ×${held.count} · last ${monthLabel(held.lastPeriod, timezone)}`
      : `✅ Earned ${shortDate(held.firstAwardedAt, timezone)}`;
  }
  if (badge.thresholdMs !== undefined) {
    const progress = `${wholeHours(standing.activeMs)} / ${wholeHours(badge.thresholdMs)}`;
    const isNext = nextHoursBadge(standing.activeMs)?.key === badge.key;
    return isNext ? `${progressBar(standing.activeMs / badge.thresholdMs)} ${progress}` : progress;
  }
  if (badge.key === "veteran" && standing.firstTrackedAt) {
    const days = Math.max(1, Math.ceil((veteranDueAt(standing.firstTrackedAt).getTime() - now.getTime()) / 86_400_000));
    return `🔒 ${days} ${days === 1 ? "day" : "days"} to go`;
  }
  return "🔒 Not earned yet";
}

export type BadgeGuide = { description: string; fields: Array<{ name: string; value: string }>; footer: string };

/**
 * The `/badges` guide: every badge and how to earn it, with the caller's own
 * progress when the tracker knows them. Somebody never tracked sees the rules
 * only, never a row of zeros.
 */
export function badgeGuide(input: { launchedAt: Date; standing: BadgeStandingView | null; now: Date; timezone: string }): BadgeGuide {
  const { standing, now, timezone } = input;
  const held = standing ? heldBadges(standing.awards) : new Map<string, HeldBadge>();
  const launched = shortDate(input.launchedAt, timezone);
  const description = standing
    ? `Badges count from launch day (${launched}), except Veteran. You have **${held.size} of ${BADGES.length}**.`
    : `Badges count from launch day (${launched}), except Veteran. Your progress shows here once you've been tracked on shift.`;
  const fields = BADGE_GROUPS.map(({ group, title, emoji }) => ({
    name: `${emoji} ${title}`,
    value: BADGES.filter((badge) => badge.group === group).map((badge) => {
      const line = `${badge.emoji} **${badge.name}** — ${badge.howToEarn}`;
      return standing ? `${line}\n${statusLine(badge, held.get(badge.key), standing, now, timezone)}` : line;
    }).join("\n\n"),
  }));
  return { description, fields, footer: "Hours badges count active time only · /profile shows your card" };
}

/** The DM sentence for one newly earned badge. */
export function awardSentence(badge: BadgeDefinition, period: string, activeMs: number, timezone: string): string {
  if (badge.thresholdMs !== undefined) {
    const next = nextHoursBadge(Math.max(activeMs, badge.thresholdMs));
    return `You've spent ${badge.name} on shift since badges launched.${next ? ` Next up: ${next.name}.` : " That's every hours badge."}`;
  }
  if (badge.key === "monthly-first") return `You finished ${monthLabel(period, timezone)} at #1 on the staff leaderboard.`;
  if (badge.key === "monthly-top3") return `You finished ${monthLabel(period, timezone)} in the top 3 on the staff leaderboard.`;
  if (badge.key === "veteran") return "You've been on the team for a whole year. Thank you!";
  return badge.howToEarn;
}
