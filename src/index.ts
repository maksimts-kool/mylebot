import { Events } from "discord.js";
import { loadConfig } from "./core/config.js";
import { prisma } from "./core/db.js";
import { createDiscordClient } from "./core/discord-client.js";
import { errorType } from "./core/errors.js";
import type { Feature, FeatureContext } from "./core/feature.js";
import { buildHttpServer } from "./core/http.js";
import { Scheduler } from "./core/scheduler.js";
import { createPortalFeature } from "./features/portal/index.js";
import { createSessionsFeature } from "./features/sessions/index.js";
import { createTaigaFeature } from "./features/taiga/index.js";
import { BloxlinkService } from "./shared/bloxlink.js";
import { RuntimeSettingsService } from "./shared/runtime-settings.js";

const config = loadConfig();
const client = createDiscordClient(config);
const app = await buildHttpServer(config, async () => { await prisma.$queryRaw`SELECT 1`; });

const ctx: FeatureContext = {
  config,
  db: prisma,
  client,
  log: app.log,
  settings: new RuntimeSettingsService(prisma),
  bloxlink: new BloxlinkService(prisma, config),
};

const features: Feature[] = [
  createSessionsFeature(ctx),
  createPortalFeature(ctx),
  createTaigaFeature(ctx),
].filter((feature): feature is Feature => feature !== null);

for (const feature of features) {
  if (feature.routes) await app.register(feature.routes);
}
const commandData = features.flatMap((feature) => feature.commands ?? []);

async function bootstrapDiscord(): Promise<void> {
  app.log.info({ phase: "discord_bootstrap" }, "Discord bootstrap started");
  try {
    if (config.DISCORD_GUILD_ID) {
      // Guild command replacement is immediate and removes stale command definitions.
      // Clear legacy global commands as well so Discord does not display duplicates.
      await client.application!.commands.set([]);
      const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
      await guild.commands.set(commandData);
      app.log.info({ phase: "discord_command_sync", commandCount: commandData.length }, "Discord guild commands synchronized");
    }
  } catch (error) {
    app.log.error({ phase: "discord_command_sync", errorType: errorType(error) }, "Discord command synchronization failed");
  }
  // One feature failing to come up must not stop the others from doing so.
  for (const feature of features) {
    if (!feature.onReady) continue;
    try {
      await feature.onReady();
    } catch (error) {
      app.log.error({ phase: "discord_bootstrap", feature: feature.name, errorType: errorType(error) }, "Feature ready hook failed");
    }
  }
  app.log.info({ phase: "discord_bootstrap" }, "Discord bootstrap completed");
}

client.once(Events.ClientReady, () => {
  void bootstrapDiscord();
});

app.log.info({ phase: "startup", features: features.map(({ name }) => name) }, "Application startup initialized");
for (const feature of features) {
  if (!feature.onStart) continue;
  try {
    await feature.onStart();
  } catch (error) {
    app.log.error({ phase: "feature_start", feature: feature.name, errorType: errorType(error) }, "Feature startup failed");
    throw error;
  }
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
app.log.info({ phase: "http_listening", host: config.API_HOST, port: config.API_PORT }, "HTTP server listening");

if (config.DISCORD_TOKEN) {
  app.log.info({ phase: "discord_login" }, "Discord login started");
  try {
    await client.login(config.DISCORD_TOKEN);
    app.log.info({ phase: "discord_login" }, "Discord login completed");
  } catch (error) {
    app.log.error({ phase: "discord_login", errorType: errorType(error) }, "Discord login failed");
    throw error;
  }
} else {
  app.log.info({ phase: "discord_login", mode: "api_only" }, "API-only mode is active");
}

const scheduler = new Scheduler(app.log);
for (const feature of features) {
  for (const job of feature.jobs ?? []) scheduler.register(job);
}

async function shutdown(signal: string) {
  app.log.info({ phase: "shutdown", signal }, "Application shutdown started");
  scheduler.stop();
  for (const feature of features) {
    if (!feature.onShutdown) continue;
    try {
      await feature.onShutdown();
    } catch (error) {
      app.log.error({ phase: "shutdown", feature: feature.name, errorType: errorType(error) }, "Feature shutdown hook failed");
    }
  }
  await app.close(); client.destroy(); await prisma.$disconnect();
  app.log.info({ phase: "shutdown", signal }, "Application shutdown completed");
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
