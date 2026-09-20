import type { CommandRisk } from "@prisma/client";
import type { Db } from "../core/db.js";
import { RISK_ORDER } from "./discord/risk.js";

/**
 * Where a staff member's two records meet: the shift the session tracker holds
 * and the Adonis commands the command log holds. Features may not import each
 * other, so this is the one place that reads both tables, and both directions
 * of the join live here rather than being written twice.
 *
 * A Roblox user id is the only thing the two sides share, which is exactly
 * what both are keyed by.
 */

/** How many distinct commands a summary names before it stops counting. */
const TOP_COMMANDS = 3;

export type CommandActivity = {
  total: number;
  /** The worst risk anything in the window carried; null when nothing ran. */
  highestRisk: CommandRisk | null;
  /** Counts per risk, worst first. A risk nothing carried is left out. */
  byRisk: { risk: CommandRisk; count: number }[];
  /** The commands run most often, most first, named as Adonis indexes them. */
  top: { name: string; count: number }[];
};

export const NO_COMMAND_ACTIVITY: CommandActivity = { total: 0, highestRisk: null, byRisk: [], top: [] };

/**
 * What one person ran between two instants — a shift, in practice.
 *
 * The window is half-open at neither end: a command run at the very instant a
 * shift started or ended belongs to it. Command records are kept for
 * `PROCESSED_EVENT_RETENTION_DAYS` while sessions are kept for a year, so an
 * old shift answers "nothing" here because its records are gone, not because
 * nothing happened. Anything reading this must treat an empty summary as
 * "nothing to show" rather than printing a zero.
 */
export async function commandActivityDuring(
  db: Db,
  window: { robloxUserId: bigint; from: Date; to: Date },
): Promise<CommandActivity> {
  const groups = await db.commandLogEntry.groupBy({
    by: ["commandName", "risk"],
    where: { robloxUserId: window.robloxUserId, occurredAt: { gte: window.from, lte: window.to } },
    _count: { _all: true },
  });
  if (!groups.length) return NO_COMMAND_ACTIVITY;

  const perRisk = new Map<CommandRisk, number>();
  const perCommand = new Map<string, number>();
  let total = 0;
  for (const group of groups) {
    const count = group._count._all;
    total += count;
    perRisk.set(group.risk, (perRisk.get(group.risk) ?? 0) + count);
    perCommand.set(group.commandName, (perCommand.get(group.commandName) ?? 0) + count);
  }

  const byRisk = RISK_ORDER
    .filter((risk) => perRisk.has(risk))
    .map((risk) => ({ risk, count: perRisk.get(risk)! }));
  const top = [...perCommand.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, TOP_COMMANDS);

  return { total, highestRisk: byRisk[0]?.risk ?? null, byRisk, top };
}

/** `Kick ×4 · Respawn ×3`, or an empty string when nothing ran. */
export function topCommandsLine(activity: CommandActivity): string {
  return activity.top.map(({ name, count }) => `${name} ×${count}`).join(" · ");
}

/** A shift as the other feature needs it: when it ran, and nothing else. */
export type TrackedShift = { id: string; startedAt: Date; endedAt: Date | null };

/**
 * Whether somebody was on shift at a given instant.
 *
 * `tracked` is the honest half. Session tracking only covers group members
 * above the configured rank, and it can be switched off entirely, so somebody
 * the tracker has never seen is not "off shift" — nothing is known about them,
 * and a surface showing this must say nothing rather than accuse them.
 */
export type ShiftStatus =
  | { tracked: false }
  | { tracked: true; shift: TrackedShift | null };

const UNTRACKED: ShiftStatus = { tracked: false };

/**
 * The shift each of these people was on at `at`, keyed by Roblox user id as a
 * decimal string. Everybody asked about gets an answer, including the people
 * the session tracker has no record of at all.
 */
export async function shiftStatusAt(db: Db, robloxUserIds: bigint[], at: Date): Promise<Map<string, ShiftStatus>> {
  const statuses = new Map<string, ShiftStatus>(robloxUserIds.map((id) => [id.toString(), UNTRACKED]));
  if (!robloxUserIds.length) return statuses;

  const identities = await db.identity.findMany({
    where: { robloxUserId: { in: robloxUserIds } },
    select: {
      robloxUserId: true,
      sessions: {
        // A shift covering the instant: started by then, and either still
        // running or ended after it. A removed one is not a shift any more.
        where: { deletedAt: null, startedAt: { lte: at }, OR: [{ endedAt: null }, { endedAt: { gte: at } }] },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { id: true, startedAt: true, endedAt: true },
      },
    },
  });
  for (const identity of identities) {
    statuses.set(identity.robloxUserId.toString(), { tracked: true, shift: identity.sessions[0] ?? null });
  }
  return statuses;
}

/** One person's answer, for a surface that only ever shows one. */
export async function shiftStatusFor(db: Db, robloxUserId: bigint, at: Date): Promise<ShiftStatus> {
  const statuses = await shiftStatusAt(db, [robloxUserId], at);
  return statuses.get(robloxUserId.toString()) ?? UNTRACKED;
}

/**
 * `1h 12m`, `4m`, `less than a minute`. Deliberately short: this sits inside a
 * line about something else, never on its own.
 */
export function compactDuration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** How long into their shift somebody was at `at`, or null when they were not on one. */
export function timeIntoShift(status: ShiftStatus, at: Date): number | null {
  if (!status.tracked || !status.shift) return null;
  return at.getTime() - status.shift.startedAt.getTime();
}
