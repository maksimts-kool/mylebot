import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { userError } from "../../../core/errors.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";
import { commandActivityDuring } from "../../../shared/staff-activity.js";
import { assertDurationInvariant } from "../domain/accounting.js";
import { SWEEP_GRACE_MS, recordedTimeMeetsSessionMinimum } from "../domain/policy.js";
import { profileStats } from "../domain/profile.js";
import { buildLeaderboard, tallinnDateRange } from "../domain/reporting.js";
import type { ManagedSession, SessionDetail, SessionsServerPort } from "../link.js";
import type { BadgeService } from "./badge-service.js";
import type { SessionPublisher } from "./publisher.js";
import { robloxHeadshot } from "./roblox-avatar.js";

export type SessionsPortDeps = {
  db: Db;
  config: Config;
  bloxlink: BloxlinkService;
  settings: RuntimeSettingsService;
  badges: BadgeService;
  publisher: SessionPublisher;
  /** Swappable so a test never reaches Roblox. */
  headshot?: typeof robloxHeadshot;
};

/**
 * Everything the session commands read and write, on the side that holds the
 * database. Each method is one thing a command does, so a command costs one
 * round trip, and the user-facing reasons a request is refused are decided
 * here, next to the rows they are about.
 */
export function sessionsServerPort(deps: SessionsPortDeps): SessionsServerPort {
  const { db, config, bloxlink, settings, badges, publisher } = deps;
  const headshot = deps.headshot ?? robloxHeadshot;

  /** A Discord member's tracked identity, or their Bloxlink mapping when the tracker has never seen them. */
  async function lookUp(discordUserId: string) {
    const identity = await db.identity.findFirst({ where: { discordUserId } });
    if (identity) return { identity, mapped: null };
    const mapped = await bloxlink.robloxForDiscord(discordUserId);
    if (!mapped) return { identity: null, mapped: null };
    return { identity: await db.identity.findUnique({ where: { robloxUserId: mapped.userId } }), mapped };
  }

  function notLinked(isSelf: boolean): never {
    userError(isSelf ? "You haven't linked a Roblox account with Bloxlink yet" : "That member hasn't linked a Roblox account with Bloxlink yet");
  }

  /** The Adonis commands run during a shift. A shift still running is asked about up to now. */
  async function withCommands<T extends { startedAt: Date; endedAt: Date | null; identity: { robloxUserId: bigint } }>(session: T) {
    const commands = await commandActivityDuring(db, {
      robloxUserId: session.identity.robloxUserId,
      from: session.startedAt,
      to: session.endedAt ?? new Date(),
    });
    return { ...session, commands };
  }

  async function manageable(id: string): Promise<ManagedSession> {
    const session = await db.session.findUnique({ where: { id }, include: { identity: true } });
    if (!session || session.deletedAt) userError("Session not found");
    if (session.state !== "ENDED") userError("Live sessions cannot be managed");
    if (!recordedTimeMeetsSessionMinimum(session.activeMilliseconds, session.inactiveMilliseconds)) userError("Session not found");
    return session;
  }

  return {
    refresh: (sessionId) => publisher.refresh(sessionId),

    async historySubject(discordUserId) {
      const { identity, mapped } = await lookUp(discordUserId);
      if (identity) return { identityId: identity.id };
      if (!mapped) userError("That member hasn't linked a Roblox account with Bloxlink yet");
      return { discordUserId };
    },

    async liveSessionFor(discordUserId, isSelf): Promise<SessionDetail> {
      const { identity, mapped } = await lookUp(discordUserId);
      // No local record only means nothing was ever tracked for them; Bloxlink
      // tells "never verified" apart from "verified but not in game".
      if (!identity && !mapped) notLinked(isSelf);
      if (!identity) userError(isSelf ? "You have no active session right now" : "That member has no active session right now");
      const session = await db.session.findFirst({
        where: { identityId: identity.id, state: { not: "ENDED" }, deletedAt: null },
        include: { segments: true, identity: true },
        orderBy: { startedAt: "desc" },
      });
      if (!session) userError(isSelf ? "You have no active session right now" : `${identity.robloxUsername} has no active session right now`);
      return withCommands(session);
    },

    liveRoster: () => db.session.findMany({
      where: { state: { not: "ENDED" }, deletedAt: null },
      include: { identity: true, segments: true },
      orderBy: { startedAt: "asc" },
    }),

    async sessionDetails(sessionId) {
      const session = await db.session.findUnique({ where: { id: sessionId }, include: { identity: true, segments: true } });
      if (!session || session.deletedAt) userError("Session not found");
      return withCommands(session);
    },

    async history(identityId) {
      const identity = await db.identity.findUnique({ where: { id: identityId } });
      if (!identity) return null;
      const sessions = await db.session.findMany({
        where: { identityId, deletedAt: null },
        include: { segments: true },
        orderBy: { startedAt: "desc" },
      });
      return { identity, sessions };
    },

    manageableSession: (sessionId) => manageable(sessionId),

    async editableSession(sessionId) {
      const current = await db.session.findUnique({ where: { id: sessionId } });
      if (!current || current.state !== "ENDED" || current.deletedAt) userError("Completed session not found");
      return { reconnectMilliseconds: Number(current.reconnectMilliseconds) };
    },

    async addManualSession(input) {
      const { start, end, activeMs: active, inactiveMs: inactive } = input;
      assertDurationInvariant(start, end, active, inactive);
      if (!recordedTimeMeetsSessionMinimum(active, inactive)) userError("A session must be at least one minute long.");
      let identity;
      if ("identityId" in input.subject) {
        identity = await db.identity.findUnique({ where: { id: input.subject.identityId } });
        if (!identity) userError("That member is no longer tracked");
      } else {
        const { discordUserId } = input.subject;
        const mapped = await bloxlink.robloxForDiscord(discordUserId);
        if (!mapped) userError("That Discord user has no Bloxlink mapping");
        identity = await db.identity.upsert({
          where: { robloxUserId: mapped.userId },
          create: { robloxUserId: mapped.userId, robloxUsername: mapped.username, discordUserId },
          update: { robloxUsername: mapped.username, discordUserId },
        });
      }
      const identityId = identity.id;
      const session = await db.$transaction(async (tx) => {
        const created = await tx.session.create({ data: {
          identityId, state: "ENDED", startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end,
          activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), rankNumber: config.ROBLOX_MIN_RANK,
          rankName: "Manual entry", universeId: config.ROBLOX_UNIVERSE_ID, placeId: config.ROBLOX_ALLOWED_PLACE_IDS[0]!, jobId: "manual",
        } });
        const activeEnd = new Date(start.getTime() + active);
        if (active) await tx.timeSegment.create({ data: { sessionId: created.id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
        if (inactive) await tx.timeSegment.create({ data: { sessionId: created.id, state: "INACTIVE", startedAt: activeEnd, endedAt: end } });
        await tx.auditEntry.create({ data: { sessionId: created.id, actorType: "DISCORD", actorId: input.actorDiscordId, action: "SESSION_ADD", note: input.note } });
        return created;
      });
      await publisher.refresh(session.id);
      return { id: session.id, robloxUsername: identity.robloxUsername };
    },

    async editEndedSession(input) {
      const id = input.sessionId;
      const current = await db.session.findUnique({ where: { id }, include: { identity: true } });
      if (!current || current.state !== "ENDED" || current.deletedAt) userError("Completed session not found");
      // Old rows can carry reconnecting time; it stays as it was and active time absorbs the rest.
      const reconnect = Number(current.reconnectMilliseconds);
      const { start, end, activeMs: active, inactiveMs: inactive } = input;
      assertDurationInvariant(start, end, active, inactive + reconnect);
      if (!recordedTimeMeetsSessionMinimum(active, inactive)) userError("A session must be at least one minute long.");
      await db.$transaction(async (tx) => {
        await tx.timeSegment.deleteMany({ where: { sessionId: id } });
        const activeEnd = new Date(start.getTime() + active);
        if (active) await tx.timeSegment.create({ data: { sessionId: id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
        const inactiveEnd = new Date(activeEnd.getTime() + inactive);
        if (inactive) await tx.timeSegment.create({ data: { sessionId: id, state: "INACTIVE", startedAt: activeEnd, endedAt: inactiveEnd } });
        if (reconnect) await tx.timeSegment.create({ data: { sessionId: id, state: "RECONNECTING", startedAt: inactiveEnd, endedAt: end } });
        await tx.session.update({ where: { id }, data: { startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end, activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), reconnectMilliseconds: BigInt(reconnect) } });
        await tx.auditEntry.create({ data: {
          sessionId: id, actorType: "DISCORD", actorId: input.actorDiscordId, action: "SESSION_EDIT_ENDED",
          note: input.note,
          before: { startedAt: current.startedAt, endedAt: current.endedAt, activeMilliseconds: current.activeMilliseconds.toString(), inactiveMilliseconds: current.inactiveMilliseconds.toString(), reconnectMilliseconds: current.reconnectMilliseconds.toString() },
          after: { startedAt: start, endedAt: end, activeMilliseconds: String(active), inactiveMilliseconds: String(inactive), reconnectMilliseconds: String(reconnect) },
        } });
      });
      await publisher.refresh(id);
      return {
        robloxUsername: current.identity.robloxUsername,
        beforeMs: Number(current.activeMilliseconds + current.inactiveMilliseconds),
      };
    },

    async removeSession(sessionId, actorDiscordId) {
      const current = await db.session.findUnique({ where: { id: sessionId }, include: { identity: true } });
      if (!current || current.deletedAt) userError("Session not found");
      if (current.state !== "ENDED") userError("Live sessions cannot be managed");
      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.session.update({ where: { id: sessionId }, data: { deletedAt: now } });
        await tx.auditEntry.create({ data: {
          sessionId, actorType: "DISCORD", actorId: actorDiscordId, action: "SESSION_REMOVE",
          before: { deletedAt: null }, after: { deletedAt: now },
        } });
      });
      await publisher.refresh(sessionId, true);
      return {
        robloxUsername: current.identity.robloxUsername,
        totalMs: Number(current.activeMilliseconds + current.inactiveMilliseconds),
      };
    },

    async firstRecordedSession() {
      const first = await db.session.findFirst({
        where: { deletedAt: null }, orderBy: { startedAt: "asc" }, select: { startedAt: true },
      });
      return first?.startedAt ?? null;
    },

    async leaderboard(startDate, endDate, minimum) {
      const { start, end } = tallinnDateRange(startDate, endDate, config.REPORT_TIMEZONE);
      const identities = await db.identity.findMany({ include: { sessions: { where: { deletedAt: null, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] }, include: { segments: true } } } });
      return buildLeaderboard(identities.map((identity) => ({
        identityId: identity.id,
        username: identity.discordUserId ? `${identity.robloxUsername} · <@${identity.discordUserId}>` : identity.robloxUsername,
        sessions: identity.sessions,
      })), start, end, minimum);
    },

    async profile(discordUserId, isSelf) {
      const now = new Date();
      const { identity, mapped } = await lookUp(discordUserId);
      if (!identity && !mapped) notLinked(isSelf);
      const robloxUserId = identity?.robloxUserId ?? mapped!.userId;
      const robloxUsername = identity?.robloxUsername ?? mapped!.username;
      const standing = await badges.standing(robloxUserId);
      // Somebody the tracker has never seen is untracked, not "zero hours".
      if (!identity && !standing.awards.length) {
        userError(isSelf ? "You haven't been tracked on shift yet" : `${robloxUsername} hasn't been tracked on shift yet`);
      }
      const sessions = identity
        ? await db.session.findMany({
          where: { identityId: identity.id, deletedAt: null },
          select: { startedAt: true, endedAt: true, deletedAt: true, rankName: true, rankNumber: true, segments: { select: { state: true, startedAt: true, endedAt: true } } },
          orderBy: { startedAt: "desc" },
        })
        : [];
      const latest = sessions[0];
      return {
        robloxUsername,
        rank: latest ? { name: latest.rankName, number: latest.rankNumber } : null,
        avatar: await headshot(robloxUserId),
        stats: profileStats(sessions, now, config.REPORT_TIMEZONE),
        standing,
      };
    },

    async badgeGuide(discordUserId) {
      const { identity } = await lookUp(discordUserId);
      if (!identity) return null;
      const held = await badges.standing(identity.robloxUserId);
      // Veteran counts from the first time the tracker saw them, even before the
      // badge pass has recorded it.
      return {
        robloxUsername: identity.robloxUsername,
        standing: { ...held, firstTrackedAt: held.firstTrackedAt ?? identity.createdAt },
      };
    },

    async trackingOverview() {
      const current = await settings.get();
      const live = { state: { not: "ENDED" as const }, deletedAt: null };
      const overdueBefore = new Date(Date.now() - config.HEARTBEAT_STALE_SECONDS * 1000 - SWEEP_GRACE_MS);
      const [liveSessions, overdueSessions, lastEvent] = await Promise.all([
        db.session.count({ where: live }),
        db.session.count({ where: { ...live, lastEventAt: { lt: overdueBefore } } }),
        db.processedEvent.findFirst({ orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
      ]);
      return { settings: current, liveSessions, overdueSessions, lastEventAt: lastEvent?.receivedAt ?? null };
    },

    setLogsChannel: async (channelId) => { await settings.setLogsChannel(channelId); },
    setStaffChannel: async (channelId) => { await settings.setStaffChannel(channelId); },
    setTrackingEnabled: async (enabled) => { await settings.setTrackingEnabled(enabled); },
  };
}
