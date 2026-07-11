import { Client, Events, GatewayIntentBits } from "discord.js";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { prisma } from "./db.js";
import { CommandHandler } from "./discord/commands.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { BloxlinkService } from "./services/bloxlink.js";
import { SessionService } from "./services/session-service.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const bloxlink = new BloxlinkService(prisma, config);
const sessions = new SessionService(prisma, config);
const publisher = new DiscordPublisher(client, prisma, config, bloxlink);
new CommandHandler(client, prisma, config, publisher, bloxlink).register();
const api = await buildApi(config, sessions, (ids) => publisher.refreshMany(ids));

client.once(Events.ClientReady, async () => {
  console.log(`Discord bot ready as ${client.user?.tag}`);
  await publisher.restore();
});

await sessions.sweep().then((ids) => publisher.refreshMany(ids));
await api.listen({ host: config.API_HOST, port: config.API_PORT });
if (config.DISCORD_TOKEN) await client.login(config.DISCORD_TOKEN);
else console.warn("DISCORD_TOKEN is empty; API-only mode is active");

const sweepTimer = setInterval(async () => {
  const ids = await sessions.sweep();
  await publisher.refreshMany(ids);
}, 15_000);
const refreshTimer = setInterval(async () => {
  const live = await prisma.session.findMany({ where: { state: { not: "ENDED" }, deletedAt: null }, select: { id: true } });
  await publisher.refreshMany(live.map(({ id }) => id));
}, config.DISCORD_UPDATE_SECONDS * 1000);

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`);
  clearInterval(sweepTimer); clearInterval(refreshTimer);
  await api.close(); client.destroy(); await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
