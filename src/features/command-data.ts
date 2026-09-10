import { verificationConfigured, type Config } from "../core/config.js";
import { configCommandData } from "./config/discord/definitions.js";
import { helpCommandData } from "./help/discord/definitions.js";
import { sessionCommandData } from "./sessions/discord/commands/definitions.js";
import { verificationCommandData } from "./verification/discord/commands.js";

/**
 * Every slash command the bot deploys, gated exactly like the features are at
 * runtime. `scripts/deploy-commands.ts` and the startup synchronization both
 * read this, so a manual deploy cannot install a command the running bot
 * refuses to answer.
 *
 * Features with settings but no command of their own — the Taiga integration,
 * for one — contribute a page to `/config` instead of a command here.
 */
export function allCommandData(config: Config) {
  return [
    ...sessionCommandData,
    ...configCommandData,
    ...helpCommandData,
    ...(verificationConfigured(config) ? verificationCommandData : []),
  ];
}
