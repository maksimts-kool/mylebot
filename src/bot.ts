import { Events, type Client } from "discord.js";
import type { Config } from "./core/config.js";
import { createDiscordClient } from "./core/discord-client.js";
import { errorType } from "./core/errors.js";
import type { BotContext, BotFeature, ServerCapabilities } from "./core/feature.js";
import { LinkUnavailableError, type Peer, type PortRegistry } from "./core/link.js";
import type { Logger } from "./core/logger.js";
import { createCommandLogsBot } from "./features/command-logs/bot.js";
import { createConfigBot } from "./features/config/bot.js";
import { createHelpBot } from "./features/help/bot.js";
import { createPortalBot } from "./features/portal/bot.js";
import { createSessionsBot } from "./features/sessions/bot.js";
import { createTaigaBot } from "./features/taiga/bot.js";
import { createVerificationBot } from "./features/verification/bot.js";
import { BOT_CORE_PORT, SHARED_PORT, type BotCorePort, type SharedServerPort } from "./shared/server-port.js";

/** How long to wait between attempts to reach a server half that is not up yet. */
const SERVER_RETRY_MS = 5_000;

/**
 * The half that holds the Discord gateway and nothing else. It has no database
 * client: everything it shows comes from the server half, through `server`,
 * and everything the server half wants shown in Discord arrives through the
 * ports this half's features expose.
 */
export type BotHalf = {
  client: Client;
  features: BotFeature[];
  /** Logs in to Discord. Call once the HTTP server is listening, so the server half can reach this one. */
  login(): Promise<void>;
  shutdown(): Promise<void>;
  /** Fails until the gateway is connected. */
  readiness(): Promise<void>;
};

export type BotHalfOptions = {
  config: Config;
  log: Logger;
  /** Where this half's ports are offered to the server half. */
  registry: PortRegistry;
  /** The server half. */
  server: Peer;
};

/**
 * Keeps calling until the server half answers. The bot half starts after it,
 * but a restart of either can leave it briefly unreachable.
 */
async function untilReachable<T>(work: () => Promise<T>, log: Logger, what: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof LinkUnavailableError)) throw error;
      if (attempt === 1) log.warn({ reason: error.message }, `The server is not reachable yet; retrying ${what}`);
      await new Promise((resolve) => setTimeout(resolve, SERVER_RETRY_MS));
    }
  }
}

export async function startBotHalf({ config, log, registry, server }: BotHalfOptions): Promise<BotHalf> {
  const startup = log.child({ category: "startup" });
  const discord = log.child({ category: "discord" });
  const shared = server.port<SharedServerPort>(SHARED_PORT);

  // Which features exist is the server half's to say: it holds the
  // configuration they need, and the gateway's intents depend on them.
  const capabilities: ServerCapabilities = await untilReachable(() => shared.capabilities(), startup, "the feature list");
  const client = createDiscordClient(config, capabilities);
  const ctx: BotContext = { config, client, log, server, shared, capabilities };

  const composed: BotFeature[] = [
    createSessionsBot(ctx),
    createCommandLogsBot(ctx),
    createPortalBot(ctx),
    createTaigaBot(ctx),
    createVerificationBot(ctx),
  ].filter((feature): feature is BotFeature => feature !== null);

  // `/config` and `/help` describe the rest of the bot, so they are built last
  // from what the other features actually declared. Features stay independent
  // of one another; only this file knows the whole set.
  const configFeature = createConfigBot(ctx, composed.flatMap((feature) => feature.configSections ?? []));
  const features: BotFeature[] = [
    ...composed,
    configFeature,
    createHelpBot(ctx, [...composed, configFeature].flatMap((feature) => feature.help ?? [])),
  ];

  const core: BotCorePort = { status: async () => ({ discordReady: client.isReady() }) };
  registry.expose(BOT_CORE_PORT, core);
  for (const feature of features) {
    for (const [name, port] of Object.entries(feature.ports ?? {})) registry.expose(name, port);
  }
  const commandData = features.flatMap((feature) => feature.commands ?? []);
  startup.info({ features: features.map(({ name }) => name) }, "Bot features loaded");

  async function bootstrap(): Promise<void> {
    try {
      if (config.DISCORD_GUILD_ID) {
        // Guild command replacement is immediate and removes stale command definitions.
        // Clear legacy global commands as well so Discord does not display duplicates.
        await client.application!.commands.set([]);
        const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
        await guild.commands.set(commandData);
        discord.info({ guild: guild.name, commands: commandData.length }, "Guild commands synchronised");
      }
    } catch (error) {
      discord.error({ err: error, errorType: errorType(error) }, "Command synchronisation failed");
    }
    // One feature failing to come up must not stop the others from doing so.
    for (const feature of features) {
      if (!feature.onReady) continue;
      try {
        await feature.onReady();
      } catch (error) {
        startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} failed to come up`);
      }
    }
    // The server half catches Discord up on whatever it could not show.
    await untilReachable(() => shared.botReady(), startup, "the ready signal")
      .catch((error: unknown) => startup.error({ err: error, errorType: errorType(error) }, "Could not tell the server the gateway is ready"));
    startup.info("Ready");
  }

  client.once(Events.ClientReady, (ready) => {
    discord.info({ actor: ready.user.username }, "Signed in");
    void bootstrap();
  });

  return {
    client,
    features,
    async login() {
      if (!config.DISCORD_TOKEN) {
        startup.info("Running without Discord; the API is the only surface");
        return;
      }
      try {
        await client.login(config.DISCORD_TOKEN);
      } catch (error) {
        discord.error({ err: error, errorType: errorType(error) }, "Login failed");
        throw error;
      }
    },
    async shutdown() {
      for (const feature of features) {
        if (!feature.onShutdown) continue;
        try {
          await feature.onShutdown();
        } catch (error) {
          startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} failed to shut down cleanly`);
        }
      }
      await client.destroy();
    },
    readiness: async () => {
      if (!client.isReady()) throw new Error("The Discord gateway is not connected");
    },
  };
}
