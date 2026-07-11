import { z } from "zod";

export const presenceEventSchema = z.object({
  eventId: z.string().uuid(),
  kind: z.enum(["JOIN", "HEARTBEAT", "LEAVE", "SHUTDOWN"]),
  occurredAt: z.string().datetime({ offset: true }),
  universeId: z.union([z.string(), z.number()]).transform(BigInt),
  placeId: z.union([z.string(), z.number()]).transform(BigInt),
  jobId: z.string().min(1).max(128),
  player: z.object({
    userId: z.union([z.string(), z.number()]).transform(BigInt),
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

