import type { Feature, FeatureContext } from "../../core/feature.js";
import { sessionRoutes } from "./api/routes.js";
import { sessionCommandData } from "./discord/commands/definitions.js";
import { SessionCommandHandler } from "./discord/commands/handler.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { SessionService } from "./service/session-service.js";

/**
 * Roblox play-session tracking: HTTP ingestion, the session lifecycle, and the
 * Discord projection of it. Discord is a projection here, never the source of
 * session truth.
 */
export function createSessionsFeature(ctx: FeatureContext): Feature {
  const sessions = new SessionService(ctx.db, ctx.config, ctx.settings);
  const publisher = new DiscordPublisher(ctx.client, ctx.db, ctx.config, ctx.bloxlink, ctx.settings);
  new SessionCommandHandler(ctx.client, ctx.db, ctx.config, publisher, ctx.bloxlink, ctx.settings).register();

  return {
    name: "sessions",
    commands: sessionCommandData,
    routes: sessionRoutes({
      config: ctx.config,
      sessions,
      onChanged: async (ids, removedMessages) => {
        await publisher.refreshMany(ids);
        if (removedMessages) await publisher.removeMessages(removedMessages);
      },
    }),
    onStart: async () => {
      // A failure here is fatal on purpose: starting up with a stale lifecycle
      // state would publish wrong session times.
      ctx.log.info({ phase: "initial_session_sweep" }, "Initial session sweep started");
      const ids = await sessions.sweep();
      await publisher.refreshMany(ids);
      ctx.log.info({ phase: "initial_session_sweep", affectedSessionCount: ids.length }, "Initial session sweep completed");
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
        name: "processed-event cleanup",
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
          const count = await sessions.cleanupProcessedEvents();
          if (count) ctx.log.info({ job: "processed-event cleanup", removedEventCount: count }, "Expired processed events removed");
        },
      },
    ],
  };
}
