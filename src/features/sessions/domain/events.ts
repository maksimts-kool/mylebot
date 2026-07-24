import { z } from "zod";

// Roblox IDs cross the JSON boundary as decimal strings (or plain numbers from
// older producers). BigInt() throws on anything else, so convert inside the
// schema: a malformed ID has to fail as a payload error, not as a 500.
const robloxId = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    return BigInt(value);
  } catch {
    context.addIssue({ code: "custom", message: `Invalid Roblox ID: ${value}` });
    return 0n;
  }
});

export const presenceEventSchema = z.object({
  eventId: z.string().uuid(),
  kind: z.enum(["JOIN", "HEARTBEAT", "LEAVE", "SHUTDOWN"]),
  occurredAt: z.string().datetime({ offset: true }),
  universeId: robloxId,
  placeId: robloxId,
  jobId: z.string().min(1).max(128),
  player: z.object({
    userId: robloxId,
    username: z.string().min(1).max(64),
    rankNumber: z.number().int().min(0).max(255),
    rankName: z.string().min(1).max(100),
    active: z.boolean(),
  }),
});

export const presenceBatchSchema = z.object({
  events: z.array(presenceEventSchema).min(1),
});

export type PresenceEvent = z.infer<typeof presenceEventSchema>;

