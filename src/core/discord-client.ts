import { Client, GatewayIntentBits } from "discord.js";
import type { Config } from "./config.js";

/**
 * Builds the gateway client. Intents are requested based on what is actually
 * configured: message intents are privileged, so a deployment that does not run
 * the Taiga forum integration must not ask for them and get its login rejected.
 */
export function createDiscordClient(config: Config): Client {
  const intents = [GatewayIntentBits.Guilds];
  if (config.TAIGA_USERNAME && config.TAIGA_PASSWORD) {
    // Reading the first message of a forum post needs the privileged
    // MessageContent intent; see README "Taiga integration".
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  return new Client({ intents });
}
