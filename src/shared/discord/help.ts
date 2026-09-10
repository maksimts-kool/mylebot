/** One command as `/help` lists it. */
export type HelpCommand = {
  /** How the command is typed, including its options: `/session active [user]`. */
  usage: string;
  description: string;
  /** The `PermissionLevel` the command requires. */
  permission: number;
};

/**
 * A feature's contribution to `/help`. Features declare this on their `Feature`
 * object; `src/index.ts` collects the sections of everything it actually
 * composed, so `/help` can never advertise a command the bot does not answer.
 */
export type HelpSection = {
  title: string;
  emoji: string;
  commands: HelpCommand[];
};
