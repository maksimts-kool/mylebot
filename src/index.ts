import { Client, Events, GatewayIntentBits } from "discord.js";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { prisma } from "./db.js";
import { CommandHandler, commandData } from "./discord/commands.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { BloxlinkService } from "./services/bloxlink.js";
import { SessionService } from "./services/session-service.js";
import { RuntimeSettingsService } from "./services/runtime-settings.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const bloxlink = new BloxlinkService(prisma, config);
const settings = new RuntimeSettingsService(prisma);
const sessions = new SessionService(prisma, config, settings);
const publisher = new DiscordPublisher(client, prisma, config, bloxlink, settings);
new CommandHandler(client, prisma, config, publisher, bloxlink, settings).register();
const api = await buildApi(config, sessions, async (ids, removedMessages) => {
  await publisher.refreshMany(ids);
  if (removedMessages) await publisher.removeMessages(removedMessages);
}, async () => { await prisma.$queryRaw`SELECT 1`; });

client.once(Events.ClientReady, async () => {
  console.log(`Discord bot ready as ${client.user?.tag}`);
  if (config.DISCORD_GUILD_ID) {
    // Guild command replacement is immediate and removes stale command definitions.
    // Clear legacy global commands as well so Discord does not display duplicates.
    await client.application!.commands.set([]);
    const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
    await guild.commands.set(commandData);
    console.log(`Synchronized ${commandData.length} Discord guild commands`);
  }
  await publisher.restore();
});

await sessions.sweep().then((ids) => publisher.refreshMany(ids));
await api.listen({ host: config.API_HOST, port: config.API_PORT });
if (config.DISCORD_TOKEN) await client.login(config.DISCORD_TOKEN);
else console.warn("DISCORD_TOKEN is empty; API-only mode is active");

let stopping = false;
function schedule(name: string, intervalMs: number, operation: () => Promise<void>): NodeJS.Timeout {
  const timer = setTimeout(async function run() {
    if (stopping) return;
    const startedAt = Date.now();
    try {
      await operation();
    } catch (error) {
      console.error(`${name} failed`, error);
    } finally {
      if (!stopping) timer.refresh();
      const duration = Date.now() - startedAt;
      if (duration > intervalMs) console.warn(`${name} took ${duration}ms (interval ${intervalMs}ms)`);
    }
  }, intervalMs);
  return timer;
}

const sweepTimer = schedule("session sweep", 15_000, async () => {
  const ids = await sessions.sweep();
  await publisher.refreshMany(ids);
});
const refreshTimer = schedule("Discord refresh", config.DISCORD_UPDATE_SECONDS * 1000, async () => {
  const live = await prisma.session.findMany({ where: { state: { not: "ENDED" }, deletedAt: null }, select: { id: true } });
  await publisher.refreshMany(live.map(({ id }) => id));
});
const cleanupTimer = schedule("processed-event cleanup", 24 * 60 * 60 * 1000, async () => {
  const count = await sessions.cleanupProcessedEvents();
  if (count) console.log(`Removed ${count} expired processed events`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`);
  stopping = true;
  clearTimeout(sweepTimer); clearTimeout(refreshTimer); clearTimeout(cleanupTimer);
  await api.close(); client.destroy(); await prisma.$disconnect();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
