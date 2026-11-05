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


/** How each event kind reads in a summary, in the order the summary lists them. */
const KIND_NOUNS: Record<PresenceEvent["kind"], string> = {
  JOIN: "join", LEAVE: "leave", SHUTDOWN: "shutdown", HEARTBEAT: "heartbeat",
};

/** Every outcome but a plain accepted event is worth a note. */
const STATUS_NOTES: Record<string, string> = {
  duplicate: "already applied",
  out_of_order: "out of order",
  tracking_disabled: "ignored because tracking is off",
  removed_low_rank: "below the minimum rank and removed",
};

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What one presence batch did, in a sentence: `1 join, 3 heartbeats; 1 shift
 * changed`. Heartbeats arrive every few seconds from every server and almost
 * never change anything, so a batch that changed nothing is routine.
 */
export function summarizePresenceBatch(
  kinds: readonly PresenceEvent["kind"][],
  statuses: readonly string[],
  changedShifts: number,
): { did: string; routine: boolean } {
  const received = (Object.keys(KIND_NOUNS) as PresenceEvent["kind"][])
    .map((kind) => [kind, kinds.filter((each) => each === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => counted(count, KIND_NOUNS[kind]));
  const notes = Object.entries(STATUS_NOTES)
    .map(([status, note]) => [statuses.filter((each) => each === status).length, note] as const)
    .filter(([count]) => count > 0)
    .map(([count, note]) => `${count} ${note}`);
  const removed = statuses.includes("removed_low_rank");
  return {
    did: [
      received.join(", "),
      changedShifts ? `${counted(changedShifts, "shift")} changed` : "nothing changed",
      ...notes,
    ].join("; "),
    routine: changedShifts === 0 && !removed,
  };
}
