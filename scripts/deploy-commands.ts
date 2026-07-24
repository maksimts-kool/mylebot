import { REST, Routes } from "discord.js";
import { loadConfig } from "../src/core/config.js";
import { allCommandData } from "../src/features/command-data.js";

const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://command-deploy.invalid/db",
  ROBLOX_INGESTION_SECRET: process.env.ROBLOX_INGESTION_SECRET ?? "command-deploy-placeholder-secret",
  ROBLOX_UNIVERSE_ID: process.env.ROBLOX_UNIVERSE_ID ?? "0",
  ROBLOX_GROUP_ID: process.env.ROBLOX_GROUP_ID ?? "0",
  ROBLOX_ALLOWED_PLACE_IDS: process.env.ROBLOX_ALLOWED_PLACE_IDS ?? "0",
});
if (!config.DISCORD_TOKEN || !config.DISCORD_APPLICATION_ID || !config.DISCORD_GUILD_ID) {
  throw new Error("DISCORD_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_GUILD_ID are required");
}
const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(config.DISCORD_APPLICATION_ID), { body: [] });
await rest.put(Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_GUILD_ID), { body: allCommandData });
console.log(`Removed legacy global commands and deployed ${allCommandData.length} guild commands`);
