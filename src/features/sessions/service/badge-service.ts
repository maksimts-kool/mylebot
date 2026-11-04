import type { BadgeAward, Prisma } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import {
  hoursBadgesEarned, monthlyAwards, monthRange, monthsToAward, veteranDue,
} from "../domain/badges.js";
import { recordedTimeMeetsSessionMinimum } from "../domain/policy.js";
import { buildLeaderboard } from "../domain/reporting.js";

const SETTINGS_ID = "global";

/** How many owed DMs one pass hands out. Each is its own Discord call. */
export const BADGE_NOTIFY_BATCH = 25;

export type BadgeStanding = {
  /** Active time credited from every settled session, back to the first shift. */
  activeMs: number;
  firstTrackedAt: Date | null;
  awards: BadgeAward[];
};

/**
 * Removes everything badges hold about one Roblox user. Called from the
 * low-rank purge inside its transaction, so a purged member keeps nothing.
 */
export async function purgeBadges(tx: Prisma.TransactionClient, robloxUserId: bigint): Promise<void> {
  await tx.badgeAward.deleteMany({ where: { robloxUserId } });
  await tx.badgeCredit.deleteMany({ where: { robloxUserId } });
  await tx.badgeProgress.deleteMany({ where: { robloxUserId } });
}

/**
 * Hands out badges from session data. Discord is not involved here: awards are
 * rows, and the notifier tells people about rows still owed a DM.
 *
 * Everything counts from each member's first tracked shift, including shifts
 * from before badges existed.
 *
 * Hours are counted from per-session credits rather than from the sessions
 * themselves, because sessions are deleted after a year and the hours they
 * earned must not go with them. A credit follows its session while the session
 * exists — an edit changes it, a removal drops it — and stays once retention
 * has deleted the session.
 */
export class BadgeService {
  constructor(private readonly db: Db, private readonly config: Config) {}

  /** How far the monthly ranking has got. The row is created the first time it is asked for. */
  private async settings(now: Date): Promise<{ monthsAwardedThrough: string | null }> {
    return this.db.badgeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, launchedAt: now },
      update: {},
      select: { monthsAwardedThrough: true },
    });
  }

  /** One awarding pass. Returns how many badges were newly earned. */
  async award(now = new Date()): Promise<number> {
    const settings = await this.settings(now);
    await this.syncProgress();
    await this.syncCredits();
    let awarded = await this.awardHours();
    awarded += await this.awardVeteran(now);
    awarded += await this.awardMonths(settings.monthsAwardedThrough, now);
    return awarded;
  }

  /** Records when each tracked person was first seen, for Veteran. Never moves a date later. */
  private async syncProgress(): Promise<void> {
    const identities = await this.db.identity.findMany({
      select: { robloxUserId: true, createdAt: true, sessions: { select: { startedAt: true }, orderBy: { startedAt: "asc" }, take: 1 } },
    });
    if (!identities.length) return;
    const known = new Map((await this.db.badgeProgress.findMany({
      where: { robloxUserId: { in: identities.map(({ robloxUserId }) => robloxUserId) } },
      select: { robloxUserId: true, firstTrackedAt: true },
    })).map((row) => [row.robloxUserId, row.firstTrackedAt]));

    const missing: Array<{ robloxUserId: bigint; firstTrackedAt: Date }> = [];
    for (const identity of identities) {
      const firstSession = identity.sessions[0]?.startedAt;
      const firstTrackedAt = firstSession && firstSession < identity.createdAt ? firstSession : identity.createdAt;
      const recorded = known.get(identity.robloxUserId);
      if (!recorded) missing.push({ robloxUserId: identity.robloxUserId, firstTrackedAt });
      else if (firstTrackedAt < recorded) {
        await this.db.badgeProgress.update({ where: { robloxUserId: identity.robloxUserId }, data: { firstTrackedAt } });
      }
    }
    if (missing.length) await this.db.badgeProgress.createMany({ data: missing, skipDuplicates: true });
  }

  /** Brings every credit in line with the settled session it came from, however old. */
  private async syncCredits(): Promise<void> {
    const sessions = await this.db.session.findMany({
      where: { state: "ENDED" },
      select: {
        id: true, deletedAt: true, activeMilliseconds: true, inactiveMilliseconds: true,
        identity: { select: { robloxUserId: true } },
      },
    });
    if (!sessions.length) return;
    const credits = new Map((await this.db.badgeCredit.findMany({
      where: { sessionId: { in: sessions.map(({ id }) => id) } },
      select: { sessionId: true, activeMilliseconds: true },
    })).map((credit) => [credit.sessionId, credit.activeMilliseconds]));

    const fresh: Array<{ sessionId: string; robloxUserId: bigint; activeMilliseconds: bigint }> = [];
    const dropped: string[] = [];
    for (const session of sessions) {
      const counts = session.deletedAt === null
        && recordedTimeMeetsSessionMinimum(session.activeMilliseconds, session.inactiveMilliseconds);
      const credited = credits.get(session.id);
      if (!counts) {
        if (credited !== undefined) dropped.push(session.id);
      } else if (credited === undefined) {
        fresh.push({ sessionId: session.id, robloxUserId: session.identity.robloxUserId, activeMilliseconds: session.activeMilliseconds });
      } else if (credited !== session.activeMilliseconds) {
        await this.db.badgeCredit.update({ where: { sessionId: session.id }, data: { activeMilliseconds: session.activeMilliseconds } });
      }
    }
    if (fresh.length) await this.db.badgeCredit.createMany({ data: fresh, skipDuplicates: true });
    if (dropped.length) await this.db.badgeCredit.deleteMany({ where: { sessionId: { in: dropped } } });
  }

  private async grant(rows: Array<{ robloxUserId: bigint; badge: string; period?: string }>): Promise<number> {
    if (!rows.length) return 0;
    const created = await this.db.badgeAward.createMany({
      data: rows.map((row) => ({ robloxUserId: row.robloxUserId, badge: row.badge, period: row.period ?? "" })),
      skipDuplicates: true,
    });
    return created.count;
  }

  private async awardHours(): Promise<number> {
    const totals = await this.db.badgeCredit.groupBy({ by: ["robloxUserId"], _sum: { activeMilliseconds: true } });
    return this.grant(totals.flatMap((total) => hoursBadgesEarned(Number(total._sum.activeMilliseconds ?? 0n))
      .map((badge) => ({ robloxUserId: total.robloxUserId, badge }))));
  }

  /** Veteran only goes to people still tracked, not to someone who left a year ago. */
  private async awardVeteran(now: Date): Promise<number> {
    const tracked = await this.db.identity.findMany({ select: { robloxUserId: true } });
    if (!tracked.length) return 0;
    const progress = await this.db.badgeProgress.findMany({
      where: { robloxUserId: { in: tracked.map(({ robloxUserId }) => robloxUserId) } },
      select: { robloxUserId: true, firstTrackedAt: true },
    });
    return this.grant(progress
      .filter((row) => veteranDue(row.firstTrackedAt, now))
      .map((row) => ({ robloxUserId: row.robloxUserId, badge: "veteran" })));
  }

  /** Ranks each finished month once, back to the first tracked shift, exactly as `/leaderboard` would have. */
  private async awardMonths(awardedThrough: string | null, now: Date): Promise<number> {
    const first = await this.db.session.findFirst({
      where: { deletedAt: null }, orderBy: { startedAt: "asc" }, select: { startedAt: true },
    });
    let awarded = 0;
    for (const month of monthsToAward(first?.startedAt ?? null, awardedThrough, now, this.config.REPORT_TIMEZONE)) {
      const { start, end } = monthRange(month, this.config.REPORT_TIMEZONE);
      const identities = await this.db.identity.findMany({
        select: {
          id: true, robloxUserId: true, robloxUsername: true,
          sessions: {
            where: { deletedAt: null, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
            select: { startedAt: true, endedAt: true, segments: { select: { state: true, startedAt: true, endedAt: true } } },
          },
        },
      });
      const robloxIds = new Map(identities.map((identity) => [identity.id, identity.robloxUserId]));
      const ranking = buildLeaderboard(identities.map((identity) => ({
        identityId: identity.id, username: identity.robloxUsername, sessions: identity.sessions,
      })), start, end).map((row) => robloxIds.get(row.identityId)!);
      awarded += await this.grant(monthlyAwards(ranking).map(({ member, badge }) => ({ robloxUserId: member, badge, period: month })));
      await this.db.badgeSettings.update({ where: { id: SETTINGS_ID }, data: { monthsAwardedThrough: month } });
    }
    return awarded;
  }

  /** Awards still owed a DM, oldest first. */
  async owedNotifications(take = BADGE_NOTIFY_BATCH): Promise<BadgeAward[]> {
    return this.db.badgeAward.findMany({ where: { notifiedAt: null }, orderBy: { awardedAt: "asc" }, take });
  }

  async markNotified(ids: string[], now = new Date()): Promise<void> {
    if (ids.length) await this.db.badgeAward.updateMany({ where: { id: { in: ids } }, data: { notifiedAt: now } });
  }

  /** Everything the profile and the guide show about one person's badges. */
  async standing(robloxUserId: bigint): Promise<BadgeStanding> {
    const [credits, progress, awards] = await Promise.all([
      this.db.badgeCredit.aggregate({ where: { robloxUserId }, _sum: { activeMilliseconds: true } }),
      this.db.badgeProgress.findUnique({ where: { robloxUserId }, select: { firstTrackedAt: true } }),
      this.db.badgeAward.findMany({ where: { robloxUserId }, orderBy: { awardedAt: "asc" } }),
    ]);
    return {
      activeMs: Number(credits._sum.activeMilliseconds ?? 0n),
      firstTrackedAt: progress?.firstTrackedAt ?? null,
      awards,
    };
  }
}
