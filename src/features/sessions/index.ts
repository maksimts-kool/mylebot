import { botInternalRoutes } from "../../core/bot-link.js";
import type { Feature, FeatureContext } from "../../core/feature.js";
import { sessionRoutes } from "./api/routes.js";
import { sessionCommandData, sessionHelp } from "./discord/commands/definitions.js";
import { SessionCommandHandler } from "./discord/commands/handler.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { SessionService, type DiscordMessageReference } from "./service/session-service.js";

/** `1 session` / `3 sessions`, so the log lines read as English. */
function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/**
 * Roblox play-session tracking: HTTP ingestion, the session lifecycle, and the
 * Discord projection of it. Discord is a projection here, never the source of
 * session truth.
 */
export function createSessionsFeature(ctx: FeatureContext): Feature {
  const log = ctx.log.child({ category: "session" });
  const sessions = new SessionService(ctx.db, ctx.config, ctx.settings, log);
  const publisher = new DiscordPublisher(ctx.client, ctx.db, ctx.config, ctx.bloxlink, ctx.settings, ctx.log);
  // Slash commands answer on the gateway, so they are only worth wiring up in
  // the process that holds one.
  if (!ctx.bot) new SessionCommandHandler(ctx.client, ctx.db, ctx.config, publisher, ctx.bloxlink, ctx.settings).register();

  /** Brings Discord up to date, here or in the container that can. */
  const publish = async (ids: string[], removedMessages?: DiscordMessageReference[]): Promise<void> => {
    if (ctx.bot) return ctx.bot.sessionsChanged(ids, removedMessages);
    await publisher.refreshMany(ids);
    if (removedMessages) await publisher.removeMessages(removedMessages);
  };

  return {
    name: "sessions",
    commands: sessionCommandData,
    help: sessionHelp,
    routes: sessionRoutes({ config: ctx.config, sessions, onChanged: publish }),
    // The API half records the change and then asks this half to show it.
    internalRoutes: botInternalRoutes({ config: ctx.config, onSessionsChanged: publish }),
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
    onReady: async () => {
      await publisher.restore();
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
          // Discord was not connected, so the removals were only queued. Keep
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
