import { ActivityType, Client, GatewayIntentBits, type PresenceData } from "discord.js";
import { verificationConfigured, type Config } from "./config.js";
import { APP_VERSION } from "./version.js";

export function botPresence(version = APP_VERSION): PresenceData {
  return {
    activities: [{ name: "Custom Status", state: `Running on v${version}`, type: ActivityType.Custom }],
    status: "online",
  };
}

/**
 * Builds the gateway client. Intents are requested based on what is actually
 * configured: message intents are privileged, so a deployment that does not run
 * the Taiga forum integration must not ask for them and get its login rejected.
 */
export function createDiscordClient(config: Config): Client {
  const intents = [GatewayIntentBits.Guilds];
  if (verificationConfigured(config)) {
    // Required to fetch every member who currently has the Unverified role.
    intents.push(GatewayIntentBits.GuildMembers);
  }
  if (config.TAIGA_USERNAME && config.TAIGA_PASSWORD) {
    // Reading the first message of a forum post needs the privileged
    // MessageContent intent; see README "Taiga integration".
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  return new Client({ intents, presence: botPresence() });
}
