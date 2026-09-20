import type { Feature, FeatureContext } from "../../core/feature.js";
import { commandBlockRoutes, commandRunRoutes } from "./api/routes.js";
import { registerCommandLogInteractions } from "./discord/interactions.js";
import { commandLogsConfigSection } from "./discord/config-section.js";
import { CommandLogPublisher } from "./discord/publisher.js";
import { CommandLogService } from "./service/command-log-service.js";
import { GroupRankService } from "./service/group-rank.js";
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
 * Adonis command logging: the game reports every command staff run, and each
 * one is posted as an embed in a thread named after the server it ran in.
 *
 * The feature needs no environment configuration of its own — it shares the
 * Roblox ingestion secret with presence tracking — so it is always composed and
 * switched on from `/config` instead.
 */
export function createCommandLogsFeature(ctx: FeatureContext): Feature {
  const settings = new CommandLogSettingsService(ctx.db);
  const service = new CommandLogService(ctx.db, ctx.config, settings, ctx.log);
  const ranks = new GroupRankService(ctx.config, ctx.log);
  const publisher = new CommandLogPublisher(ctx.client, ctx.db, ctx.bloxlink, settings, service, ctx.log);

  registerCommandLogInteractions(ctx.client, { service, publisher, bloxlink: ctx.bloxlink, ranks, log: ctx.log });

  return {
    name: "command-logs",
    configSections: [commandLogsConfigSection(settings, service)],
    // Recording a run means posting it, which can only happen where Discord is.
    gatewayRoutes: {
      plugin: commandRunRoutes({
        config: ctx.config,
        service,
        onRecorded: (entries) => publisher.postMany(entries),
        onReported: (roster) => publisher.syncServer(roster),
      }),
      patterns: ["/v1/roblox/commands/batch", "/v1/roblox/commands/roster"],
    },
    // The block list is a plain database read, so the plugin can keep polling
    // it from the API half even while the gateway is down.
    routes: commandBlockRoutes({ config: ctx.config, service }),
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
          if (!closed.length) return undefined;
          await publisher.closeServers(closed);
          return `closed ${closed.length} server panel(s) that stopped reporting`;
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
