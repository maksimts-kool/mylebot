import { Prisma, type Session, type SessionState } from "@prisma/client";
import type { Config } from "../config.js";
import type { PresenceEvent } from "../domain/events.js";
import type { prisma as database } from "../db.js";
import type { RuntimeSettingsService } from "./runtime-settings.js";

type Db = typeof database;
export type DiscordMessageReference = { channelId: string; messageId: string };

export type EventResult = {
  eventId: string;
  status: "accepted" | "duplicate" | "out_of_order" | "tracking_disabled" | "removed_low_rank";
  sessionId?: string | undefined;
  alsoChangedSessionId?: string | undefined;
  removedMessages?: DiscordMessageReference[] | undefined;
  changed: boolean;
};

function elapsed(from: Date, to: Date): bigint {
  return BigInt(Math.max(0, to.getTime() - from.getTime()));
}

function counterUpdate(state: SessionState, amount: bigint): Prisma.SessionUpdateInput {
  if (state === "ACTIVE") return { activeMilliseconds: { increment: amount } };
  if (state === "INACTIVE") return { inactiveMilliseconds: { increment: amount } };
  if (state === "RECONNECTING") return { reconnectMilliseconds: { increment: amount } };
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

  async process(event: PresenceEvent): Promise<EventResult> {
    if (this.settings && !(await this.settings.get()).trackingEnabled) {
      return { eventId: event.eventId, status: "tracking_disabled", changed: false };
    }
    this.validateSource(event);
    if (event.player.rankNumber < this.config.ROBLOX_MIN_RANK) return this.purgeLowRankPlayer(event);
    this.validateRank(event);
    return this.db.$transaction(async (tx) => {
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
      let alsoChangedSessionId: string | undefined;
      if (session?.state === "RECONNECTING" && session.reconnectDeadline && occurredAt > session.reconnectDeadline && (event.kind === "JOIN" || event.kind === "HEARTBEAT")) {
        const endedAt = session.reconnectDeadline;
        await tx.timeSegment.updateMany({ where: { sessionId: session.id, endedAt: null }, data: { endedAt } });
        await tx.session.update({
          where: { id: session.id },
          data: { ...counterUpdate("RECONNECTING", elapsed(session.lastStateAt, endedAt)), state: "ENDED", endedAt, lastStateAt: endedAt, reconnectDeadline: null },
        });
        alsoChangedSessionId = session.id;
        session = null;
      }
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
        const desired: SessionState = event.kind === "LEAVE" || event.kind === "SHUTDOWN"
          ? "RECONNECTING"
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
      return { eventId: event.eventId, status: "accepted", sessionId: session?.id, alsoChangedSessionId, changed: changed || Boolean(alsoChangedSessionId) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async purgeLowRankPlayer(event: PresenceEvent): Promise<EventResult> {
    const removedMessages = await this.db.$transaction(async (tx) => {
      const identity = await tx.identity.findUnique({
        where: { robloxUserId: event.player.userId },
        include: { sessions: { include: { discordMessage: true } } },
      });
      if (!identity) return [];

      const sessionIds = identity.sessions.map(({ id }) => id);
      const messages = identity.sessions.flatMap(({ discordMessage }) => discordMessage ? [{
        channelId: discordMessage.channelId,
        messageId: discordMessage.messageId,
      }] : []);
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

  private async transition(
    tx: Prisma.TransactionClient,
    session: Session,
    next: SessionState,
    at: Date,
    event?: PresenceEvent,
  ): Promise<Session> {
    const reconnectDeadline = next === "RECONNECTING"
      ? new Date(at.getTime() + this.config.RECONNECT_GRACE_SECONDS * 1000)
      : null;
    await tx.timeSegment.updateMany({ where: { sessionId: session.id, endedAt: null }, data: { endedAt: at } });
    await tx.timeSegment.create({ data: { sessionId: session.id, state: next, startedAt: at } });
    return tx.session.update({
      where: { id: session.id },
      data: {
        ...counterUpdate(session.state, elapsed(session.lastStateAt, at)),
        state: next, lastStateAt: at, lastEventAt: event ? at : session.lastEventAt, reconnectDeadline,
        ...(event ? { placeId: event.placeId, jobId: event.jobId, rankNumber: event.player.rankNumber, rankName: event.player.rankName } : {}),
      },
    });
  }

  async sweep(now = new Date()): Promise<string[]> {
    if (this.settings && !(await this.settings.get()).trackingEnabled) return [];
    const changed: string[] = [];
    const staleBefore = new Date(now.getTime() - this.config.HEARTBEAT_STALE_SECONDS * 1000);
    const stale = await this.db.session.findMany({ where: { state: { in: ["ACTIVE", "INACTIVE"] }, lastEventAt: { lt: staleBefore }, deletedAt: null } });
    for (const session of stale) {
      const transitionAt = new Date(session.lastEventAt.getTime() + this.config.HEARTBEAT_STALE_SECONDS * 1000);
      await this.db.$transaction(async (tx) => { await this.transition(tx, session, "RECONNECTING", transitionAt); });
      changed.push(session.id);
    }
    const expired = await this.db.session.findMany({ where: { state: "RECONNECTING", reconnectDeadline: { lte: now }, deletedAt: null } });
    for (const session of expired) {
      const endedAt = session.reconnectDeadline ?? now;
      await this.db.$transaction(async (tx) => {
        await tx.timeSegment.updateMany({ where: { sessionId: session.id, endedAt: null }, data: { endedAt } });
        await tx.session.update({
          where: { id: session.id },
          data: { ...counterUpdate("RECONNECTING", elapsed(session.lastStateAt, endedAt)), state: "ENDED", endedAt, lastStateAt: endedAt, reconnectDeadline: null },
        });
      });
      changed.push(session.id);
    }
    return changed;
  }
}
