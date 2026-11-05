import type { ServerContext, ServerFeature } from "../../core/feature.js";
import { sessionRoutes } from "./api/routes.js";
import { SESSIONS_PORT, type DiscordMessageReference, type SessionsBotPort } from "./link.js";
import { BadgeNotifier } from "./service/badge-notifier.js";
import { BadgeService } from "./service/badge-service.js";
import { SessionPublisher } from "./service/publisher.js";
import { SessionService } from "./service/session-service.js";
import { sessionsServerPort } from "./service/sessions-port.js";

/** `1 session` / `3 sessions`, so the log lines read as English. */
function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/**
 * Roblox play-session tracking, the half that owns it: HTTP ingestion, the
 * session lifecycle, badges, and deciding what Discord should show. Discord
 * is a projection, never the source of session truth, so the bot half is only
 * ever asked to show what this half already recorded.
 */
export function createSessionsServer(ctx: ServerContext): ServerFeature {
  const log = ctx.log.child({ category: "session" });
  const discord = ctx.bot.port<SessionsBotPort>(SESSIONS_PORT);
  const sessions = new SessionService(ctx.db, ctx.config, ctx.settings, log);
  const publisher = new SessionPublisher(ctx.db, ctx.config, ctx.bloxlink, ctx.settings, discord, ctx.log);
  const badges = new BadgeService(ctx.db, ctx.config);
  const badgeNotifier = new BadgeNotifier(ctx.db, badges, ctx.bloxlink, discord, ctx.log);

  /** Brings Discord up to date with what a batch changed. */
  const publish = async (ids: string[], removedMessages?: DiscordMessageReference[]): Promise<void> => {
    await publisher.refreshMany(ids);
    if (removedMessages) await publisher.removeMessages(removedMessages);
  };

  return {
    name: "sessions",
    routes: sessionRoutes({ config: ctx.config, sessions, onChanged: publish }),
    ports: {
      [SESSIONS_PORT]: sessionsServerPort({
        db: ctx.db, config: ctx.config, bloxlink: ctx.bloxlink, settings: ctx.settings, badges, publisher,
      }),
    },
    onStart: async () => {
      const cleanup = await sessions.cleanupSessionData();
      await publisher.removeMessages(cleanup.removedMessages);
      if (cleanup.removedSessionCount || cleanup.removedIdentityCount) {
        log.info(
          { sessions: cleanup.removedSessionCount, identities: cleanup.removedIdentityCount, messages: cleanup.removedMessages.length },
          "Cleared expired session data",
        );
      }
      // A failure here is fatal on purpose: starting up with a stale lifecycle
      // state would publish wrong session times.
      const ids = await sessions.sweep();
      await publisher.refreshMany(ids);
      if (ids.length) log.info(`Closed ${plural(ids.length, "session")} left open by the last shutdown`);
    },
    onBotReady: async () => {
      const restored = await publisher.restore();
      if (restored) log.info(`Brought ${plural(restored, "session")} up to date in Discord`);
    },
    jobs: [
      {
        name: "session sweep",
        intervalMs: 15_000,
        run: async () => {
          const ids = await sessions.sweep();
          await publisher.refreshMany(ids);
          return ids.length ? `ended ${plural(ids.length, "stale session")}` : undefined;
        },
      },
      {
        name: "Discord refresh",
        intervalMs: ctx.config.DISCORD_UPDATE_SECONDS * 1000,
        run: async () => {
          const live = await ctx.db.session.findMany({ where: { state: { not: "ENDED" }, deletedAt: null }, select: { id: true } });
          await publisher.refreshMany(live.map(({ id }) => id));
        },
      },
      {
        // The staff chat announcement is a notification, not a record: once a
        // shift has been over for its retention window the message comes down,
        // leaving the permanent copy in the logs channel. Messages are removed
        // before the rows are, so a failed removal is retried rather than
        // leaving a message nothing owns.
        name: "announcement cleanup",
        intervalMs: 60_000,
        run: async () => {
          const expired = await sessions.expiredAnnouncements();
          if (!expired.length) return;
          const removed = await publisher.removeMessages(expired.map(({ channelId, messageId }) => ({ channelId, messageId })));
          // Discord was not reachable, so the removals were only queued. Keep
          // the rows and take them down on a later pass.
          if (!removed) return;
          const forgotten = await sessions.forgetAnnouncements(expired.map(({ id }) => id));
          return forgotten ? `took down ${plural(forgotten, "ended shift announcement")}` : undefined;
        },
      },
      {
        name: "session data cleanup",
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
          const cleanup = await sessions.cleanupSessionData();
          await publisher.removeMessages(cleanup.removedMessages);
          if (!cleanup.removedSessionCount && !cleanup.removedIdentityCount) return;
          return `removed ${plural(cleanup.removedSessionCount, "session")} and ${plural(cleanup.removedIdentityCount, "identity", "identities")}`;
        },
      },
      {
        // Badges are rows first and DMs second, so a DM that fails is retried
        // without the badge ever being awarded twice.
        name: "badge awards",
        intervalMs: 5 * 60_000,
        run: async () => {
          const awarded = await badges.award();
          const told = await badgeNotifier.notifyOwed();
          if (!awarded && !told) return;
          return `awarded ${plural(awarded, "badge")} and told ${plural(told, "member")}`;
        },
      },
      {
        name: "processed-event cleanup",
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
          const count = await sessions.cleanupProcessedEvents();
          return count ? `removed ${plural(count, "expired event")}` : undefined;
        },
      },
    ],
  };
}
