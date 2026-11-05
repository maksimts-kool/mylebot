import type { FastifyInstance } from "fastify";
import type { Config } from "./core/config.js";
import { prisma } from "./core/db.js";
import { errorType } from "./core/errors.js";
import type { ServerContext, ServerFeature } from "./core/feature.js";
import { LinkUnavailableError, type Peer, type PortRegistry } from "./core/link.js";
import type { Logger } from "./core/logger.js";
import { Scheduler } from "./core/scheduler.js";
import { createCommandLogsServer } from "./features/command-logs/server.js";
import { createPortalServer } from "./features/portal/server.js";
import { createSessionsServer } from "./features/sessions/server.js";
import { createTaigaServer } from "./features/taiga/server.js";
import { createVerificationServer } from "./features/verification/server.js";
import { BloxlinkService } from "./shared/bloxlink.js";
import { PermissionRoleService } from "./shared/permission-roles.js";
import { RuntimeSettingsService } from "./shared/runtime-settings.js";
import { BOT_CORE_PORT, SHARED_PORT, type BotCorePort, type SharedServerPort } from "./shared/server-port.js";

/**
 * The half that owns the database and every integration. It answers every
 * external HTTP request, runs every scheduled job, and reaches Discord only by
 * asking the bot half through `bot`.
 */
export type ServerHalf = {
  features: ServerFeature[];
  /** Arms the scheduled jobs. Call once the HTTP server is listening. */
  startJobs(): void;
  /**
   * Asks the bot half whether its gateway is already up — this half may have
   * restarted under a bot that never went away — and catches Discord up if so.
   * Otherwise the bot half says so itself when it connects.
   */
  catchUpWithBot(): Promise<void>;
  shutdown(): Promise<void>;
  /** Fails while the database cannot be reached. */
  readiness(): Promise<void>;
};

export type ServerHalfOptions = {
  config: Config;
  log: Logger;
  app: FastifyInstance;
  /** Where this half's ports are offered to the bot half. */
  registry: PortRegistry;
  /** The bot half. */
  bot: Peer;
};

export async function startServerHalf({ config, log, app, registry, bot }: ServerHalfOptions): Promise<ServerHalf> {
  const startup = log.child({ category: "startup" });
  const ctx: ServerContext = {
    config,
    db: prisma,
    log,
    settings: new RuntimeSettingsService(prisma),
    bloxlink: new BloxlinkService(prisma, config),
    bot,
  };

  const features: ServerFeature[] = [
    createSessionsServer(ctx),
    createCommandLogsServer(ctx),
    createPortalServer(ctx),
    createTaigaServer(ctx),
    createVerificationServer(ctx),
  ].filter((feature): feature is ServerFeature => feature !== null);

  // Catching Discord up runs one pass at a time: a bot that reconnects while a
  // pass is still running queues the next one behind it.
  let catchingUp: Promise<void> = Promise.resolve();
  const runBotReady = (): Promise<void> => {
    catchingUp = catchingUp.then(async () => {
      for (const feature of features) {
        if (!feature.onBotReady) continue;
        try {
          await feature.onBotReady();
        } catch (error) {
          startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} could not catch Discord up`);
        }
      }
    });
    return catchingUp;
  };

  const permissions = new PermissionRoleService(prisma);
  const shared: SharedServerPort = {
    capabilities: async () => ({ taiga: features.some(({ name }) => name === "taiga") }),
    // The bot is not kept waiting while Discord is caught up; that pass calls
    // back into it many times over.
    botReady: async () => {
      startup.info("The bot is connected; catching Discord up");
      void runBotReady();
    },
    permissionLevel: (roleIds) => permissions.levelFor(roleIds),
    robloxForDiscord: (discordUserId) => ctx.bloxlink.robloxForDiscord(discordUserId),
    permissionRoles: () => permissions.list(),
    permissionRole: (roleId) => permissions.get(roleId),
    setPermissionRole: (roleId, level) => permissions.set(roleId, level),
    removePermissionRole: (roleId) => permissions.remove(roleId),
  };
  registry.expose(SHARED_PORT, shared);
  for (const feature of features) {
    for (const [name, port] of Object.entries(feature.ports ?? {})) registry.expose(name, port);
    if (feature.routes) await app.register(feature.routes);
  }

  for (const feature of features) {
    if (!feature.onStart) continue;
    try {
      await feature.onStart();
    } catch (error) {
      startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} failed to start`);
      throw error;
    }
  }
  startup.info({ features: features.map(({ name }) => name) }, "Server features loaded");

  const scheduler = new Scheduler(log);

  return {
    features,
    startJobs() {
      for (const feature of features) {
        for (const job of feature.jobs ?? []) scheduler.register(job);
      }
    },
    async catchUpWithBot() {
      try {
        const { discordReady } = await bot.port<BotCorePort>(BOT_CORE_PORT).status();
        if (discordReady) await runBotReady();
      } catch (error) {
        if (!(error instanceof LinkUnavailableError)) throw error;
        startup.info("The bot is not up yet; Discord catches up when it connects");
      }
    },
    async shutdown() {
      scheduler.stop();
      for (const feature of features) {
        if (!feature.onShutdown) continue;
        try {
          await feature.onShutdown();
        } catch (error) {
          startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} failed to shut down cleanly`);
        }
      }
      await prisma.$disconnect();
    },
    readiness: async () => { await prisma.$queryRaw`SELECT 1`; },
  };
}
