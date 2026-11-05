import type { ServerContext, ServerFeature } from "../../core/feature.js";
import { commandBlockRoutes, commandRunRoutes } from "./api/routes.js";
import { COMMAND_LOGS_PORT, type CommandLogsBotPort } from "./link.js";
import { CommandLogService } from "./service/command-log-service.js";
import { commandLogsServerPort } from "./service/command-logs-port.js";
import { GroupRankService } from "./service/group-rank.js";
import { CommandLogPublisher } from "./service/publisher.js";
import { CommandLogSettingsService } from "./service/settings.js";

/** A block is checked to the minute, so sweeping expired ones can be lazy. */
const BLOCK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long a server may go without reporting before its panel is closed. The
 * plugin reports every minute, so this is several missed reports rather than
 * one slow one.
 */
const SERVER_STALE_MS = 5 * 60 * 1000;

/**
 * Adonis command logging, the half that owns it: the game reports every
 * command staff run, each is stored here, and the bot half posts it as an
 * embed in a thread named after the server it ran in.
 *
 * The feature needs no environment configuration of its own — it shares the
 * Roblox ingestion secret with presence tracking — so it is always composed and
 * switched on from `/config` instead.
 */
export function createCommandLogsServer(ctx: ServerContext): ServerFeature {
  const settings = new CommandLogSettingsService(ctx.db);
  const service = new CommandLogService(ctx.db, ctx.config, settings);
  const ranks = new GroupRankService(ctx.config, ctx.log);
  const publisher = new CommandLogPublisher(
    ctx.db, ctx.bloxlink, settings, service, ctx.bot.port<CommandLogsBotPort>(COMMAND_LOGS_PORT), ctx.log,
  );

  return {
    name: "command-logs",
    routes: async (app) => {
      await app.register(commandRunRoutes({
        config: ctx.config,
        service,
        onRecorded: (entries) => publisher.postMany(entries),
        onReported: (roster) => publisher.syncServer(roster),
      }));
      // The block list is a plain database read, so the plugin can keep
      // polling it while Discord is down.
      await app.register(commandBlockRoutes({ config: ctx.config, service }));
    },
    ports: {
      [COMMAND_LOGS_PORT]: commandLogsServerPort({ service, settings, publisher, bloxlink: ctx.bloxlink, ranks }),
    },
    jobs: [
      {
        name: "Command block cleanup",
        intervalMs: BLOCK_CLEANUP_INTERVAL_MS,
        run: async () => {
          const count = await service.cleanupExpiredBlocks();
          return count ? `restored command access for ${count}` : undefined;
        },
      },
      {
        name: "Server panel sweep",
        intervalMs: 60 * 1000,
        run: async () => {
          const closed = await service.closeSilentServers(SERVER_STALE_MS);
          if (closed.length) await publisher.closeServers(closed);
          const removed = await publisher.removeEmpty(ctx.config.PROCESSED_EVENT_RETENTION_DAYS);
          const said = [
            closed.length ? `closed ${closed.length} server panel(s) that stopped reporting` : "",
            removed ? `removed ${removed} server panel(s) with no commands` : "",
          ].filter(Boolean);
          return said.length ? said.join("; ") : undefined;
        },
      },
      {
        name: "Command log cleanup",
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
          const entries = await service.cleanupEntries(ctx.config.PROCESSED_EVENT_RETENTION_DAYS);
          const servers = await service.cleanupClosedServers(ctx.config.PROCESSED_EVENT_RETENTION_DAYS);
          if (!entries && !servers) return undefined;
          return `removed ${entries} expired command records and ${servers} closed server(s)`;
        },
      },
    ],
  };
}
