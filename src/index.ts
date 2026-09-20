import { Events } from "discord.js";
import { createBotLink, gatewayProxy } from "./core/bot-link.js";
import { loadConfig } from "./core/config.js";
import { prisma } from "./core/db.js";
import { createDiscordClient } from "./core/discord-client.js";
import { errorType } from "./core/errors.js";
import type { Feature, FeatureContext } from "./core/feature.js";
import { buildHttpServer } from "./core/http.js";
import { createAppLogger, setAppLogger } from "./core/logger.js";
import { Scheduler } from "./core/scheduler.js";
import { APP_VERSION } from "./core/version.js";
import { createCommandLogsFeature } from "./features/command-logs/index.js";
import { createConfigFeature } from "./features/config/index.js";
import { createHelpFeature } from "./features/help/index.js";
import { createPortalFeature } from "./features/portal/index.js";
import { createSessionsFeature } from "./features/sessions/index.js";
import { createTaigaFeature } from "./features/taiga/index.js";
import { createVerificationFeature } from "./features/verification/index.js";
import { BloxlinkService } from "./shared/bloxlink.js";
import { RuntimeSettingsService } from "./shared/runtime-settings.js";

const config = loadConfig();
const log = createAppLogger(config);
// Discord builds its interaction handlers far from here, so they reach for the
// logger rather than being handed one.
setAppLogger(log);
const startup = log.child({ category: "startup" });
const discord = log.child({ category: "discord" });

// `all` is one process doing both halves. Split apart, `server` answers HTTP
// and `bot` holds the Discord gateway along with everything that needs it:
// the scheduled jobs, the slash commands, and the message publishing.
const holdsGateway = config.APP_ROLE !== "server";
const servesApi = config.APP_ROLE !== "bot";

startup.info({ version: APP_VERSION, role: config.APP_ROLE, env: config.NODE_ENV }, "MyLE Bot starting");

const client = createDiscordClient(config);
const app = await buildHttpServer(config, async () => { await prisma.$queryRaw`SELECT 1`; }, log);

const ctx: FeatureContext = {
  config,
  db: prisma,
  client,
  log,
  settings: new RuntimeSettingsService(prisma),
  bloxlink: new BloxlinkService(prisma, config),
  bot: createBotLink(config, log),
};

const composed: Feature[] = [
  createSessionsFeature(ctx),
  createCommandLogsFeature(ctx),
  createPortalFeature(ctx),
  createTaigaFeature(ctx),
  createVerificationFeature(ctx),
].filter((feature): feature is Feature => feature !== null);

// `/config` and `/help` describe the rest of the bot, so they are built last
// from what the other features actually declared. Features stay independent of
// one another; only this file knows the whole set.
const configFeature = createConfigFeature(ctx, composed.flatMap((feature) => feature.configSections ?? []));
const features: Feature[] = [
  ...composed,
  configFeature,
  createHelpFeature(ctx, [...composed, configFeature].flatMap((feature) => feature.help ?? [])),
];

// Routes that need Discord run where Discord is. When it is elsewhere, the
// API half hands those paths straight over instead of answering them.
const forwarded: string[] = [];
for (const feature of features) {
  if (servesApi && feature.routes) await app.register(feature.routes);
  if (!feature.gatewayRoutes) continue;
  if (holdsGateway) await app.register(feature.gatewayRoutes.plugin);
  else forwarded.push(...feature.gatewayRoutes.patterns);
}
if (forwarded.length) {
  await app.register(gatewayProxy({ config, patterns: forwarded, log }));
  startup.info({ paths: forwarded }, "Forwarding the Discord-backed endpoints to the bot");
}
if (config.APP_ROLE === "bot") {
  for (const feature of features) {
    if (feature.internalRoutes) await app.register(feature.internalRoutes);
  }
}
const commandData = features.flatMap((feature) => feature.commands ?? []);

async function bootstrapDiscord(): Promise<void> {
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
  startup.info("Ready");
}

client.once(Events.ClientReady, (ready) => {
  discord.info({ actor: ready.user.username }, "Signed in");
  void bootstrapDiscord();
});

for (const feature of features) {
  if (!holdsGateway || !feature.onStart) continue;
  try {
    await feature.onStart();
  } catch (error) {
    startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} failed to start`);
    throw error;
  }
}
startup.info({ features: features.map(({ name }) => name) }, "Features loaded");

await app.listen({ host: config.API_HOST, port: config.API_PORT });
log.info({ category: "http" }, `Listening on ${config.API_HOST}:${config.API_PORT}`);

if (holdsGateway && config.DISCORD_TOKEN) {
  try {
    await client.login(config.DISCORD_TOKEN);
  } catch (error) {
    discord.error({ err: error, errorType: errorType(error) }, "Login failed");
    throw error;
  }
} else if (holdsGateway) {
  startup.info("Running without Discord; the API is the only surface");
}

// Jobs run once per deployment, in the half that can act on what they find.
const scheduler = new Scheduler(log);
if (holdsGateway) {
  for (const feature of features) {
    for (const job of feature.jobs ?? []) scheduler.register(job);
  }
}

async function shutdown(signal: string) {
  startup.info({ signal }, "Shutting down");
  scheduler.stop();
  for (const feature of features) {
    if (!feature.onShutdown) continue;
    try {
      await feature.onShutdown();
    } catch (error) {
      startup.error({ err: error, errorType: errorType(error), feature: feature.name }, `${feature.name} failed to shut down cleanly`);
    }
  }
  await app.close(); client.destroy(); await prisma.$disconnect();
  startup.info("Stopped");
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
