import { Prisma, type Session, type SessionState } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";
import type { PresenceEvent } from "../domain/events.js";
import { announcementRetentionCutoff, recordedTimeMeetsSessionMinimum, sessionRetentionCutoff } from "../domain/policy.js";

export type DiscordMessageReference = { channelId: string; messageId: string };

/** A staff-chat announcement that is due to be taken down. */
export type ExpiredAnnouncement = DiscordMessageReference & { id: string };

/**
 * How many announcements one cleanup pass takes down. Each removal is its own
 * Discord call, so a backlog — the first run after this retention was
 * introduced, say — is cleared over several passes instead of one long job.
 */
export const ANNOUNCEMENT_CLEANUP_BATCH = 100;

export type SessionDataCleanupResult = {
  removedSessionCount: number;
  removedIdentityCount: number;
  removedMessages: DiscordMessageReference[];
};

export type EventResult = {
  eventId: string;
  status: "accepted" | "duplicate" | "out_of_order" | "tracking_disabled" | "removed_low_rank";
  sessionId?: string | undefined;
  removedMessages?: DiscordMessageReference[] | undefined;
  changed: boolean;
};

function elapsed(from: Date, to: Date): bigint {
  return BigInt(Math.max(0, to.getTime() - from.getTime()));
}

function counterUpdate(state: SessionState, amount: bigint): Prisma.SessionUpdateInput {
  if (state === "ACTIVE") return { activeMilliseconds: { increment: amount } };
  if (state === "INACTIVE") return { inactiveMilliseconds: { increment: amount } };
  return {};
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings?: RuntimeSettingsService,
  ) {}

  private validateSource(event: PresenceEvent, now = new Date()): void {
    if (event.universeId !== this.config.ROBLOX_UNIVERSE_ID) throw new Error("Unknown universe ID");
    if (!this.config.ROBLOX_ALLOWED_PLACE_IDS.includes(event.placeId)) throw new Error("Unknown place ID");
    const drift = Math.abs(now.getTime() - new Date(event.occurredAt).getTime());
    if (drift > this.config.MAX_EVENT_AGE_SECONDS * 1000) throw new Error("Event timestamp is stale or too far in the future");
  }

  private validateRank(event: PresenceEvent): void {
    if (event.player.rankNumber < this.config.ROBLOX_MIN_RANK || event.player.rankNumber > this.config.ROBLOX_MAX_RANK) {
      throw new Error("Player rank is not eligible");
    }
  }

  validate(event: PresenceEvent, now = new Date()): void {
    this.validateSource(event, now);
    this.validateRank(event);
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === "P2034" || error.code === "P2002");
        if (!retryable || attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
  }

  async process(event: PresenceEvent): Promise<EventResult> {
    if (this.settings && !(await this.settings.get()).trackingEnabled) {
      return { eventId: event.eventId, status: "tracking_disabled", changed: false };
    }
    this.validateSource(event);
    if (event.player.rankNumber < this.config.ROBLOX_MIN_RANK) return this.purgeLowRankPlayer(event);
    this.validateRank(event);
    return this.withSerializableRetry(() => this.db.$transaction(async (tx) => {
      const prior = await tx.processedEvent.findUnique({ where: { eventId: event.eventId } });
      if (prior) return { eventId: event.eventId, status: "duplicate", sessionId: prior.sessionId ?? undefined, changed: false };

      const occurredAt = new Date(event.occurredAt);
      const identity = await tx.identity.upsert({
        where: { robloxUserId: event.player.userId },
        create: { robloxUserId: event.player.userId, robloxUsername: event.player.username },
        update: { robloxUsername: event.player.username },
      });
      let session = await tx.session.findFirst({
        where: { identityId: identity.id, state: { not: "ENDED" }, deletedAt: null },
        orderBy: { startedAt: "desc" },
      });
      if (session && occurredAt <= session.lastEventAt) {
        await tx.processedEvent.create({ data: { eventId: event.eventId, kind: event.kind, occurredAt, sessionId: session.id } });
        return { eventId: event.eventId, status: "out_of_order", sessionId: session.id, changed: false };
      }

      let changed = false;
      if (!session && (event.kind === "JOIN" || event.kind === "HEARTBEAT")) {
        const state: SessionState = event.player.active ? "ACTIVE" : "INACTIVE";
        session = await tx.session.create({
          data: {
            identityId: identity.id, state, startedAt: occurredAt, lastEventAt: occurredAt, lastStateAt: occurredAt,
            rankNumber: event.player.rankNumber, rankName: event.player.rankName, universeId: event.universeId,
            placeId: event.placeId, jobId: event.jobId, segments: { create: { state, startedAt: occurredAt } },
          },
        });
        changed = true;
      } else if (session) {
        const teardown = event.kind === "LEAVE" || event.kind === "SHUTDOWN";
        if (teardown && session.jobId !== event.jobId) {
          // The player already moved to a newer server and this teardown is from
          // the old one they left. Ignore it so their shift keeps running (and its
          // server id keeps tracking the newest server) instead of ending early.
          await tx.processedEvent.create({ data: { eventId: event.eventId, kind: event.kind, occurredAt, sessionId: session.id } });
          return { eventId: event.eventId, status: "out_of_order", sessionId: session.id, changed: false };
        }
        // A departure or shutdown ends the shift there and then: there is no
        // grace period, so the next join starts a new session.
        const desired: SessionState = teardown
          ? "ENDED"
          : event.player.active ? "ACTIVE" : "INACTIVE";
        if (session.state !== desired) {
          session = await this.transition(tx, session, desired, occurredAt, event);
          changed = true;
        } else {
          session = await tx.session.update({
            where: { id: session.id },
            data: {
              lastEventAt: occurredAt, rankNumber: event.player.rankNumber, rankName: event.player.rankName,
              placeId: event.placeId, jobId: event.jobId,
            },
          });
        }
      }

      await tx.processedEvent.create({
        data: { eventId: event.eventId, kind: event.kind, occurredAt, sessionId: session?.id ?? null },
      });
      return { eventId: event.eventId, status: "accepted", sessionId: session?.id, changed };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async purgeLowRankPlayer(event: PresenceEvent): Promise<EventResult> {
    const removedMessages = await this.db.$transaction(async (tx) => {
      const identity = await tx.identity.findUnique({
        where: { robloxUserId: event.player.userId },
        include: { sessions: { include: { discordMessage: true, announcement: true } } },
      });
      if (!identity) return [];

      const sessionIds = identity.sessions.map(({ id }) => id);
      // Both the session log and the staff announcement have to come down; the
      // rows themselves are removed by the cascade on the session delete.
      const messages = identity.sessions.flatMap(({ discordMessage, announcement }) => [discordMessage, announcement]
        .filter((message) => message !== null)
        .map(({ channelId, messageId }) => ({ channelId, messageId })));
      if (sessionIds.length) {
        await tx.auditEntry.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.processedEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.session.deleteMany({ where: { identityId: identity.id } });
      }
      await tx.identity.delete({ where: { id: identity.id } });
      return messages;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { eventId: event.eventId, status: "removed_low_rank", removedMessages, changed: false };
  }

  /**
   * Moves a session to its next state: close the open segment, credit the time
   * to the state being left, update the session, then open the next segment.
   * `ENDED` is terminal, so it closes the session instead of opening a segment.
   */
  private async transition(
    tx: Prisma.TransactionClient,
    session: Session,
    next: SessionState,
    at: Date,
    event?: PresenceEvent,
  ): Promise<Session> {
    await tx.timeSegment.updateMany({ where: { sessionId: session.id, endedAt: null }, data: { endedAt: at } });
    if (next !== "ENDED") await tx.timeSegment.create({ data: { sessionId: session.id, state: next, startedAt: at } });
    return tx.session.update({
      where: { id: session.id },
      data: {
        ...counterUpdate(session.state, elapsed(session.lastStateAt, at)),
        state: next, lastStateAt: at, lastEventAt: event ? at : session.lastEventAt, reconnectDeadline: null,
        ...(next === "ENDED" ? { endedAt: at } : {}),
        ...(event ? { placeId: event.placeId, jobId: event.jobId, rankNumber: event.player.rankNumber, rankName: event.player.rankName } : {}),
      },
    });
  }

  /**
   * Ends every session whose player stopped reporting. A session goes stale one
   * heartbeat interval after its last event and ends at that instant, so the
   * recorded time never counts the silence.
   */
  async sweep(now = new Date()): Promise<string[]> {
    if (this.settings && !(await this.settings.get()).trackingEnabled) return [];
    const changed: string[] = [];
    const staleBefore = new Date(now.getTime() - this.config.HEARTBEAT_STALE_SECONDS * 1000);
    const stale = await this.db.session.findMany({ where: { state: { in: ["ACTIVE", "INACTIVE"] }, lastEventAt: { lt: staleBefore }, deletedAt: null } });
    for (const session of stale) {
      const didChange = await this.withSerializableRetry(() => this.db.$transaction(async (tx) => {
        const current = await tx.session.findFirst({
          where: { id: session.id, state: { in: ["ACTIVE", "INACTIVE"] }, lastEventAt: session.lastEventAt, deletedAt: null },
        });
        if (!current) return false;
        await this.transition(tx, current, "ENDED", new Date(current.lastEventAt.getTime() + this.config.HEARTBEAT_STALE_SECONDS * 1000));
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      if (didChange) changed.push(session.id);
    }
    changed.push(...await this.closeLegacyReconnectingSessions());
    return changed;
  }

  /**
   * Reconnect grace periods no longer exist, so nothing enters `RECONNECTING`
   * any more. Sessions left in that state by an older build would otherwise
   * stay live forever and hold the one-live-session index, so close them at the
   * instant the player left. Remove this once no deployment can carry them.
   */
  private async closeLegacyReconnectingSessions(): Promise<string[]> {
    const closed: string[] = [];
    const stuck = await this.db.session.findMany({ where: { state: "RECONNECTING", deletedAt: null } });
    for (const session of stuck) {
      const didChange = await this.withSerializableRetry(() => this.db.$transaction(async (tx) => {
        const current = await tx.session.findFirst({ where: { id: session.id, state: "RECONNECTING", lastStateAt: session.lastStateAt, deletedAt: null } });
        if (!current) return false;
        await this.transition(tx, current, "ENDED", current.lastStateAt);
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      if (didChange) closed.push(session.id);
    }
    return closed;
  }

  async cleanupProcessedEvents(now = new Date()): Promise<number> {
    const receivedBefore = new Date(now.getTime() - this.config.PROCESSED_EVENT_RETENTION_DAYS * 86_400_000);
    const result = await this.db.processedEvent.deleteMany({ where: { receivedAt: { lt: receivedBefore } } });
    return result.count;
  }

  /**
   * The staff-chat announcements whose shift settled long enough ago that they
   * should come down. This only reads: the caller takes the messages down and
   * then calls `forgetAnnouncements`, so a failed removal is retried on the
   * next pass instead of leaving a message nobody owns any more.
   */
  async expiredAnnouncements(now = new Date(), take = ANNOUNCEMENT_CLEANUP_BATCH): Promise<ExpiredAnnouncement[]> {
    const cutoff = announcementRetentionCutoff(now);
    return this.db.sessionAnnouncement.findMany({
      take,
      where: {
        session: {
          OR: [
            { endedAt: { lte: cutoff } },
            { endedAt: null, deletedAt: { lte: cutoff } },
          ],
        },
      },
      select: { id: true, channelId: true, messageId: true },
    });
  }

  /** Drops the announcement rows whose messages have been taken down. */
  async forgetAnnouncements(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const removed = await this.db.sessionAnnouncement.deleteMany({ where: { id: { in: ids } } });
    return removed.count;
  }

  async cleanupSessionData(now = new Date()): Promise<SessionDataCleanupResult> {
    const retentionCutoff = sessionRetentionCutoff(now);
    return this.db.$transaction(async (tx) => {
      const completed = await tx.session.findMany({
        where: { state: "ENDED" },
        select: {
          id: true,
          endedAt: true,
          activeMilliseconds: true,
          inactiveMilliseconds: true,
          discordMessage: { select: { channelId: true, messageId: true } },
          announcement: { select: { channelId: true, messageId: true } },
        },
      });
      const expired = completed.filter((session) =>
        (session.endedAt !== null && session.endedAt < retentionCutoff)
        || !recordedTimeMeetsSessionMinimum(session.activeMilliseconds, session.inactiveMilliseconds));
      const sessionIds = expired.map(({ id }) => id);
      const removedMessages = expired.flatMap(({ discordMessage, announcement }) => [discordMessage, announcement]
        .filter((message) => message !== null));

      let removedSessionCount = 0;
      if (sessionIds.length) {
        await tx.auditEntry.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.processedEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
        const removed = await tx.session.deleteMany({ where: { id: { in: sessionIds }, state: "ENDED" } });
        removedSessionCount = removed.count;
      }
      const removedIdentities = await tx.identity.deleteMany({ where: { sessions: { none: {} } } });
      return { removedSessionCount, removedIdentityCount: removedIdentities.count, removedMessages };
    });
  }
}
