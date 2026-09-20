import { z } from "zod";

// Roblox IDs cross the JSON boundary as decimal strings, exactly as they do
// for presence events. A malformed ID has to fail as a payload error.
export const robloxId = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    return BigInt(value);
  } catch {
    context.addIssue({ code: "custom", message: `Invalid Roblox ID: ${value}` });
    return 0n;
  }
});

/**
 * Private and reserved servers are never logged, so the plugin only ever
 * reports these two. Anything else is a payload error rather than a quiet skip.
 */
export const SERVER_TYPES = ["PUBLIC", "STUDIO"] as const;

export const commandEventSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  universeId: robloxId,
  placeId: robloxId,
  /** Studio has no `game.JobId`, so the plugin makes one up for the session. */
  jobId: z.string().min(1).max(128),
  serverType: z.enum(SERVER_TYPES),
  playerCount: z.number().int().min(0).max(700),
  maxPlayers: z.number().int().min(0).max(700),
  runner: z.object({
    userId: robloxId,
    username: z.string().min(1).max(64),
    rankNumber: z.number().int().min(0).max(255),
    /** Empty when the group rank could not be read; never a stand-in phrase. */
    rankName: z.string().max(100).default(""),
    /** The Adonis level the runner holds. */
    adminLevel: z.number().int().min(0).max(1000),
  }),
  command: z.object({
    /** What was typed, filtered and trimmed by Adonis. */
    text: z.string().min(1).max(500),
    /** The matched command name, as Adonis indexes it: `Kick`, `ViewCommands`. */
    name: z.string().min(1).max(100),
    /** The alias that was typed, without its prefix: `kick`, `cmds`. */
    alias: z.string().min(1).max(100),
    /** The level the command demands, which is what its risk is read from. */
    requiredLevel: z.number().int().min(0).max(1000),
  }),
  /** Everybody the command resolved to, when it took players as arguments. */
  targets: z.array(z.string().min(1).max(64)).max(25).default([]),
});

export const commandBatchSchema = z.object({
  events: z.array(commandEventSchema).min(1),
});

export type CommandEvent = z.infer<typeof commandEventSchema>;
