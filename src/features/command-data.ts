import { taigaConfigured, type Config } from "../core/config.js";
import { sessionCommandData } from "./sessions/discord/commands/definitions.js";
import { taigaCommandData } from "./taiga/discord/commands.js";

/**
 * Every slash command the bot deploys, gated exactly like the features are at
 * runtime. `scripts/deploy-commands.ts` and the startup synchronization both
 * read this, so a manual deploy cannot install a command the running bot
 * refuses to answer.
 */
export function allCommandData(config: Config) {
  return [
    ...sessionCommandData,
    ...(taigaConfigured(config) ? taigaCommandData : []),
  ];
}
