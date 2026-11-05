import { ActivityType, Client, GatewayIntentBits, type PresenceData } from "discord.js";
import { verificationConfigured, type Config } from "./config.js";
import { APP_VERSION } from "./version.js";

export function botPresence(version = APP_VERSION): PresenceData {
  return {
    activities: [{ name: "Custom Status", state: `Running on v${version}`, type: ActivityType.Custom }],
    status: "online",
  };
}

/** What the server half runs, which decides which intents are worth asking for. */
export type GatewayNeeds = {
  /** The Taiga forum integration reads the first message of every new forum post. */
  taiga: boolean;
};

/**
 * Builds the gateway client. Intents are requested based on what is actually
 * configured: message intents are privileged, so a deployment that does not run
 * the Taiga forum integration must not ask for them and get its login rejected.
 * The bot half holds no Taiga credentials, so the server half says whether it
 * runs the integration.
 */
export function createDiscordClient(config: Config, needs: GatewayNeeds = { taiga: false }): Client {
  const intents = [GatewayIntentBits.Guilds];
  if (verificationConfigured(config)) {
    // Required to fetch every member who currently has the Unverified role.
    intents.push(GatewayIntentBits.GuildMembers);
  }
  if (needs.taiga) {
    // Reading the first message of a forum post needs the privileged
    // MessageContent intent; see README "Taiga integration".
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  return new Client({ intents, presence: botPresence() });
}
