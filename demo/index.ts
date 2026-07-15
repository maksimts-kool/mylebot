import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadDemoConfig } from "./config.js";
import { commandData } from "./discord/commands.js";
import { StaffingBot } from "./discord/staffing-bot.js";
import { IdentityService } from "./services/identity.js";
import { RobloxOpenCloudService } from "./services/roblox-open-cloud.js";
import { StaffService } from "./services/staff-service.js";
import { Store } from "./store/store.js";

// Standalone demo bot. Runs as its own Discord application, entirely separate from
// the production src/index.ts service. Nothing here touches the real bot or its DB.
const config = loadDemoConfig();

const store = await Store.open(config.DEMO_STORE_PATH || null);
const identity = new IdentityService({
  bloxlinkApiKey: config.DEMO_BLOXLINK_API_KEY || null,
  bloxlinkBaseUrl: config.DEMO_BLOXLINK_BASE_URL,
  guildId: config.DEMO_GUILD_ID || null,
});
const roblox = new RobloxOpenCloudService({
  apiKey: config.DEMO_ROBLOX_OPEN_CLOUD_API_KEY || null,
  groupId: config.DEMO_ROBLOX_GROUP_ID,
  baseUrl: config.DEMO_OPEN_CLOUD_BASE_URL,
});
const service = new StaffService(store, identity, roblox, config.DEMO_PASSING_SCORE);

if (!config.DEMO_DISCORD_TOKEN) {
  console.error("DEMO_DISCORD_TOKEN is not set. To try the flow without Discord, run: npx tsx demo/simulate.ts");
  process.exit(1);
}

// MessageContent is privileged and only needed for TEXT questions (thread replies).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
new StaffingBot(client, store, service).register();

client.once(Events.ClientReady, async (ready) => {
  console.log(`Demo staffing bot ready as ${ready.user.tag} (application ${ready.application.id})`);
  if (!config.DEMO_GUILD_ID) {
    console.warn("DEMO_GUILD_ID not set — commands were not registered to a guild.");
    return;
  }
  try {
    const guild = await client.guilds.fetch(config.DEMO_GUILD_ID);
    const registered = await guild.commands.set(commandData);
    console.log(`Registered ${registered.size} demo commands to ${guild.name}: ${[...registered.values()].map((c) => `/${c.name}`).join(", ")}`);
    console.log("If Discord still shows the old list, fully quit and reopen the client (or press Ctrl+R) — the server side updates instantly, the client caches.");
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    console.error("Failed to register demo commands.", error);
    if (String(code) === "50001") {
      console.error("→ 403 Missing Access: re-invite THIS bot with the `applications.commands` scope (not just `bot`).");
    } else {
      console.error("→ Check that the bot is in DEMO_GUILD_ID and that DEMO_GUILD_ID is this server's id.");
    }
  }
});

process.once("SIGINT", () => { client.destroy(); process.exit(0); });
process.once("SIGTERM", () => { client.destroy(); process.exit(0); });

await client.login(config.DEMO_DISCORD_TOKEN);
