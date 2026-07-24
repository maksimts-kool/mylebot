import { sessionCommandData } from "./sessions/discord/commands/definitions.js";

/**
 * Every slash command the bot deploys. `scripts/deploy-commands.ts` and the
 * startup synchronization both read this list, so the two cannot drift.
 */
export const allCommandData = [
  ...sessionCommandData,
];
