/** How long a Discord press takes someone's command access away for. */
export const BLOCK_MINUTES = 15;

/**
 * Commands that only look something up. They are the bulk of what staff type
 * and none of it is worth a thread entry, so the backend drops them rather
 * than asking every place to agree on a filter. Anything that changes the game
 * or another player belongs in the log, however harmless it looks.
 *
 * Adonis identifies a command twice over: by the index it is registered under
 * (`ViewCommands`) and by the alias that was actually typed (`cmds`). The two
 * rarely match, so both spellings are listed and both are checked — a run is
 * dropped if either one is in here.
 */
export const QUIET_COMMANDS = new Set([
  "viewcommands", "cmds",
  "playerlist", "players",
  "view", "resetview", "unview",
  "getping",
  "shownotes", "notes",
  "showwarnings", "warnings",
  "adminlist", "admins",
  "logs", "chatlogs", "joinlogs", "leavelogs", "errorlogs", "exploitlogs", "shutdownlogs",
  "banlist", "mutelist", "timebanlist",
  "freecam", "unfreecam", "togglefreecam",
]);

export function isQuietCommand(name: string, alias: string): boolean {
  return QUIET_COMMANDS.has(name.trim().toLowerCase()) || QUIET_COMMANDS.has(alias.trim().toLowerCase());
}
