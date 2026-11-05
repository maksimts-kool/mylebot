import { Prisma, type SessionState } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";
import { commandActivityDuring } from "../../../shared/staff-activity.js";
import { totalsForPeriod, type Totals } from "../domain/accounting.js";
import {
  MINIMUM_SESSION_MILLISECONDS, announcementRetentionElapsed, restoreCutoff, sessionMeetsMinimum,
} from "../domain/policy.js";
import { calendarYearRange } from "../domain/reporting.js";
import type {
  DiscordMessageReference, SessionAnnouncementView, SessionMessageView, SessionRecordView, SessionsBotPort,
} from "../link.js";

/**
 * How a session remembers the message it owns in one channel. `claim` is the
 * race-safe half: the row's `sessionId` is unique, so exactly one writer can
 * claim it, and whoever loses knows the message it just sent is a duplicate.
 */
type MessageStore = {
  /** Records a message posted where the session had none. False means another writer won. */
  claim: (channelId: string, messageId: string) => Promise<boolean>;
  /** Points the session at a replacement for a message that is already gone. */
  replace: (channelId: string, messageId: string) => Promise<void>;
};

type SessionRecord = {
  id: string;
  identityId: string;
  state: SessionState;
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
  deletedAt: Date | null;
  rankName: string;
  placeId: bigint;
  jobId: string;
  identity: { robloxUserId: bigint; robloxUsername: string; discordUserId: string | null };
  discordMessage: { channelId: string; messageId: string } | null;
  announcement: { channelId: string; messageId: string } | null;
};

/**
 * Decides what a session looks like in Discord and keeps the rows that say
 * which messages it owns. Discord itself is the bot half's: this asks it to
 * edit or post, and records whatever it says it did.
 *
 * Discord is a projection here, never the source of session truth, so every
 * failure to reach it is logged and left for the next refresh or for
 * `restore`, which runs whenever the bot's gateway comes up.
 */
export class SessionPublisher {
  private readonly pendingMessageRemovals: DiscordMessageReference[] = [];
  /**
   * One refresh per session at a time. Three callers drive this independently —
   * the sweep job, the periodic refresh job and the presence endpoint — and two
   * of them arriving together used to read "no message yet", both post, and
   * leave one of the two orphaned at whatever state it was posted in.
   */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly log: Logger;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly bloxlink: BloxlinkService,
    private readonly settings: RuntimeSettingsService,
    private readonly discord: SessionsBotPort,
    log: Logger,
  ) {
    this.log = log.child({ category: "discord" });
  }

  /**
   * Refreshes each session in turn. The bot being unreachable stops the pass
   * quietly — every remaining session would fail the same way, and `restore`
   * catches them all up once the gateway is back.
   */
  async refreshMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.refresh(id);
      } catch (error) {
        if (error instanceof LinkUnavailableError) {
          this.log.debug({ sessions: ids.length, reason: error.message }, "Discord is not reachable; session messages will catch up when it is");
          return;
        }
        this.log.error({ err: error, errorType: errorType(error), sessionId: id }, "Session message refresh failed");
      }
    }
  }

  /**
   * Takes messages down, or queues them for `restore` when the bot cannot. The
   * return says which happened, so a caller that is about to forget the
   * messages can wait for a pass that actually removed them.
   */
  async removeMessages(messages: DiscordMessageReference[]): Promise<boolean> {
    if (!messages.length) return true;
    try {
      await this.discord.removeMessages(messages);
      return true;
    } catch (error) {
      if (!(error instanceof LinkUnavailableError)) throw error;
      this.pendingMessageRemovals.push(...messages);
      return false;
    }
  }

  /**
   * Brings a session's messages up to date, one refresh at a time per session.
   * Callers queue behind each other rather than racing, so the message a
   * session owns is read after the previous pass has finished writing it.
   */
  async refresh(sessionId: string, includeDeleted = false): Promise<void> {
    const queued = (this.inFlight.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.publishSession(sessionId, includeDeleted));
    this.inFlight.set(sessionId, queued);
    try {
      await queued;
    } finally {
      if (this.inFlight.get(sessionId) === queued) this.inFlight.delete(sessionId);
    }
  }

  private async publishSession(sessionId: string, includeDeleted: boolean): Promise<void> {
    const settings = await this.settings.get();
    if (!settings.logsChannelId && !settings.staffChannelId) return;
    const session = await this.db.session.findUnique({
      where: { id: sessionId }, include: { identity: true, segments: true, discordMessage: true, announcement: true },
    });
    if (!session || (session.deletedAt && !includeDeleted)) return;
    // Accounting stops at the end of the shift; the announcement's retention is
    // measured against the wall clock, so the two instants are kept apart.
    const at = new Date();
    const now = session.endedAt ?? at;
    const totals = totalsForPeriod(session.segments, session.startedAt, now, now);

    // A record too short to count is not a record at all: take both of its
    // messages back down rather than leaving them behind.
    if (session.state === "ENDED" && totals.totalMs < MINIMUM_SESSION_MILLISECONDS) {
      const stale = [session.discordMessage, session.announcement].filter((message) => message !== null);
      if (stale.length) {
        await this.discord.removeMessages(stale.map(({ channelId, messageId }) => ({ channelId, messageId })));
        await this.db.discordMessage.deleteMany({ where: { sessionId: session.id } });
        await this.db.sessionAnnouncement.deleteMany({ where: { sessionId: session.id } });
        this.log.info(
          { actor: session.identity.robloxUsername, sessionId: session.id, messages: stale.length },
          "Took down the messages of a shift shorter than a minute",
        );
      }
      return;
    }

    if (settings.logsChannelId) await this.publishLog(session, settings.logsChannelId, totals, now);
    if (settings.staffChannelId) await this.publishAnnouncement(session, settings.staffChannelId, totals, at);
  }

  private async discordUserFor(session: SessionRecord): Promise<string | null> {
    return session.identity.discordUserId ?? await this.bloxlink.discordForRoblox(session.identity.robloxUserId);
  }

  /** The full, permanent record of a shift in the session logs channel. */
  private async publishLog(session: SessionRecord, logsChannelId: string, totals: Totals, now: Date): Promise<void> {
    // What they actually did on the shift, from the Adonis command log. A
    // deployment not running command logging, and a shift old enough for its
    // records to have aged out, both answer nothing — and nothing is what the
    // record then says, rather than a zero that reads like idleness.
    const commands = await commandActivityDuring(this.db, {
      robloxUserId: session.identity.robloxUserId, from: session.startedAt, to: now,
    });
    let history: SessionRecordView["history"] = null;
    if (session.state === "ENDED") {
      const year = calendarYearRange(now, this.config.REPORT_TIMEZONE);
      const reportYear = new Intl.DateTimeFormat("en", { timeZone: this.config.REPORT_TIMEZONE, year: "numeric" }).format(now);
      const yearSessions = await this.db.session.findMany({
        where: { identityId: session.identityId, deletedAt: null, startedAt: { lt: year.end }, OR: [{ endedAt: null }, { endedAt: { gt: year.start } }] },
        include: { segments: true },
      });
      const yearMs = yearSessions
        .filter((item) => sessionMeetsMinimum(item, now))
        .reduce((sum, item) => sum + totalsForPeriod(item.segments, year.start, year.end, now).totalMs, 0);
      const previous = (await this.db.session.findMany({
        where: { identityId: session.identityId, id: { not: session.id }, deletedAt: null, endedAt: { lt: session.startedAt } },
        include: { segments: true },
        orderBy: { endedAt: "desc" },
      })).find((item) => sessionMeetsMinimum(item, now));
      history = { reportYear, yearMs, previousEndedAt: previous?.endedAt ?? null };
    }
    const view: SessionRecordView = {
      kind: "record",
      sessionId: session.id,
      identityId: session.identityId,
      state: session.state,
      startedAt: session.startedAt,
      lastEventAt: session.lastEventAt,
      deletedAt: session.deletedAt,
      rankName: session.rankName,
      placeId: session.placeId,
      jobId: session.jobId,
      robloxUsername: session.identity.robloxUsername,
      discordUserId: await this.discordUserFor(session),
      totals,
      commands,
      history,
    };
    await this.publish(session.discordMessage, logsChannelId, view, {
      claim: (channelId, messageId) => this.claim(
        () => this.db.discordMessage.create({ data: { sessionId: session.id, channelId, messageId } }),
      ),
      replace: (channelId, messageId) => this.db.discordMessage.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, channelId, messageId },
        update: { channelId, messageId },
      }).then(() => undefined),
    });
  }

  /**
   * A single short message in the staff chat channel: the member is mentioned
   * outside the embed when their shift starts, and that same message is edited
   * when it ends. Nothing about it changes while the shift is running, so a
   * live session is left alone instead of being edited on every refresh.
   *
   * The announcement is temporary — the `announcement cleanup` job takes it
   * down once the shift has been settled for its retention window — so past
   * that point this publishes nothing rather than reposting an old shift.
   */
  private async publishAnnouncement(session: SessionRecord, staffChannelId: string, totals: Totals, now: Date): Promise<void> {
    const settled = session.state === "ENDED" || session.deletedAt !== null;
    if (session.announcement && !settled) return;
    if (settled && announcementRetentionElapsed(session, now)) return;
    const view: SessionAnnouncementView = {
      kind: "announcement",
      sessionId: session.id,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      deletedAt: session.deletedAt,
      robloxUsername: session.identity.robloxUsername,
      discordUserId: await this.discordUserFor(session),
      totals,
    };
    await this.publish(session.announcement, staffChannelId, view, {
      claim: (channelId, messageId) => this.claim(
        () => this.db.sessionAnnouncement.create({ data: { sessionId: session.id, channelId, messageId } }),
      ),
      replace: (channelId, messageId) => this.db.sessionAnnouncement.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, channelId, messageId },
        update: { channelId, messageId },
      }).then(() => undefined),
    });
  }

  /**
   * Runs an insert whose unique `sessionId` decides the winner. A duplicate-key
   * failure is the answer, not an error: somebody else already owns the
   * session's message in that channel.
   */
  private async claim(insert: () => Promise<unknown>): Promise<boolean> {
    try {
      await insert();
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  /**
   * Has the bot edit the message the session already owns, or post a new one,
   * and records the outcome. A fresh post is only kept if the session had no
   * message to begin with and this pass wins the claim on it. Losing means a
   * concurrent pass posted one too, so ours is taken straight back down
   * instead of being left in the channel with nothing pointing at it.
   */
  private async publish(
    existing: DiscordMessageReference | null,
    channelId: string,
    view: SessionMessageView,
    store: MessageStore,
  ): Promise<void> {
    const reference = existing ? { channelId: existing.channelId, messageId: existing.messageId } : null;
    const result = await this.discord.upsertMessage(channelId, reference, view);
    if (result.status === "edited") return;
    if (existing) {
      await store.replace(result.channelId, result.messageId);
      return;
    }
    if (await store.claim(result.channelId, result.messageId)) return;
    this.log.debug({ messageId: result.messageId, sessionId: view.sessionId }, "Discarded a duplicate session message");
    await this.removeMessages([{ channelId: result.channelId, messageId: result.messageId }]);
  }

  /**
   * Catches Discord up once the gateway is ready: removals queued while it was
   * not, every live session, every announcement still up, and the finished
   * records whose session changed recently enough to have changed unseen.
   * Returns how many sessions it brought up to date.
   */
  async restore(now = new Date()): Promise<number> {
    const pending = this.pendingMessageRemovals.splice(0);
    await this.removeMessages(pending);
    const sessions = await this.db.session.findMany({
      where: {
        deletedAt: null,
        OR: [
          { state: { not: "ENDED" } },
          { announcement: { isNot: null } },
          { discordMessage: { isNot: null }, updatedAt: { gte: restoreCutoff(now) } },
        ],
      },
      select: { id: true },
    });
    await this.refreshMany(sessions.map(({ id }) => id));
    return sessions.length;
  }
}
