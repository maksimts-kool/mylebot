import { Client, DiscordAPIError, EmbedBuilder, Events, GatewayIntentBits } from "discord.js";
import { buildApi, type SendDirectMessage } from "./api.js";
import { loadConfig } from "./config.js";
import { prisma } from "./db.js";
import { CommandHandler, commandData } from "./discord/commands.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { BloxlinkService } from "./services/bloxlink.js";
import { SessionService } from "./services/session-service.js";
import { RuntimeSettingsService } from "./services/runtime-settings.js";

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const bloxlink = new BloxlinkService(prisma, config);
const settings = new RuntimeSettingsService(prisma);
const sessions = new SessionService(prisma, config, settings);
const publisher = new DiscordPublisher(client, prisma, config, bloxlink, settings);
new CommandHandler(client, prisma, config, publisher, bloxlink, settings).register();

// Sends a Discord DM on behalf of the store-owners site. Discord code 50007
// means the recipient has DMs closed or shares no guild with the bot.
const sendDirectMessage: SendDirectMessage = async (input) => {
  if (!client.isReady()) return { ok: false, status: 503, error: "discord_not_ready" };
  try {
    const user = await client.users.fetch(input.discordId);
    const embed = new EmbedBuilder().setTitle(input.title).setDescription(input.message);
    if (input.color !== undefined) embed.setColor(input.color);
    if (input.url) embed.setURL(input.url);
    await user.send({ embeds: [embed] });
    return { ok: true };
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === 50007) return { ok: false, status: 422, error: "dms_closed" };
    console.warn("Site notify DM failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
    return { ok: false, status: 502, error: "dm_send_failed" };
  }
};

const api = await buildApi(config, sessions, async (ids, removedMessages) => {
  await publisher.refreshMany(ids);
  if (removedMessages) await publisher.removeMessages(removedMessages);
}, async () => { await prisma.$queryRaw`SELECT 1`; }, sendDirectMessage);

async function bootstrapDiscord(): Promise<void> {
  api.log.info({ phase: "discord_bootstrap" }, "Discord bootstrap started");
  try {
    if (config.DISCORD_GUILD_ID) {
      // Guild command replacement is immediate and removes stale command definitions.
      // Clear legacy global commands as well so Discord does not display duplicates.
      await client.application!.commands.set([]);
      const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
      await guild.commands.set(commandData);
      api.log.info({ phase: "discord_command_sync", commandCount: commandData.length }, "Discord guild commands synchronized");
    }
    await publisher.restore();
    api.log.info({ phase: "discord_bootstrap" }, "Discord bootstrap completed");
  } catch (error) {
    api.log.error({ phase: "discord_bootstrap", errorType: errorType(error) }, "Discord bootstrap failed");
  }
}

client.once(Events.ClientReady, () => {
  void bootstrapDiscord();
});

api.log.info({ phase: "startup" }, "Application startup initialized");
api.log.info({ phase: "initial_session_sweep" }, "Initial session sweep started");
try {
  const ids = await sessions.sweep();
  await publisher.refreshMany(ids);
  api.log.info({ phase: "initial_session_sweep", affectedSessionCount: ids.length }, "Initial session sweep completed");
} catch (error) {
  api.log.error({ phase: "initial_session_sweep", errorType: errorType(error) }, "Initial session sweep failed");
  throw error;
}
await api.listen({ host: config.API_HOST, port: config.API_PORT });
api.log.info({ phase: "http_listening", host: config.API_HOST, port: config.API_PORT }, "HTTP server listening");
if (config.DISCORD_TOKEN) {
  api.log.info({ phase: "discord_login" }, "Discord login started");
  try {
    await client.login(config.DISCORD_TOKEN);
    api.log.info({ phase: "discord_login" }, "Discord login completed");
  } catch (error) {
    api.log.error({ phase: "discord_login", errorType: errorType(error) }, "Discord login failed");
    throw error;
  }
} else {
  api.log.info({ phase: "discord_login", mode: "api_only" }, "API-only mode is active");
}

let stopping = false;
function schedule(name: string, intervalMs: number, operation: () => Promise<void>): NodeJS.Timeout {
  const timer = setTimeout(async function run() {
    if (stopping) return;
    const startedAt = Date.now();
    try {
      await operation();
      api.log.info({ job: name, durationMs: Date.now() - startedAt }, "Scheduled job completed");
    } catch (error) {
      api.log.error({ job: name, errorType: errorType(error), durationMs: Date.now() - startedAt }, "Scheduled job failed");
    } finally {
      if (!stopping) timer.refresh();
      const duration = Date.now() - startedAt;
      if (duration > intervalMs) api.log.warn({ job: name, durationMs: duration, intervalMs }, "Scheduled job exceeded its interval");
    }
  }, intervalMs);
  api.log.info({ job: name, intervalMs }, "Scheduled job registered");
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
  if (count) api.log.info({ job: "processed-event cleanup", removedEventCount: count }, "Expired processed events removed");
});

async function shutdown(signal: string) {
  api.log.info({ phase: "shutdown", signal }, "Application shutdown started");
  stopping = true;
  clearTimeout(sweepTimer); clearTimeout(refreshTimer); clearTimeout(cleanupTimer);
  await api.close(); client.destroy(); await prisma.$disconnect();
  api.log.info({ phase: "shutdown", signal }, "Application shutdown completed");
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
