import { z } from "zod";
import { robloxId } from "./events.js";
import { SERVER_TYPES } from "./events.js";

/**
 * A staff member the plugin reports as being in a server right now. Only
 * people Adonis grants a level are reported: everybody else is a player, and
 * this panel is about who can run commands.
 */
export const staffPresenceSchema = z.object({
  userId: robloxId,
  username: z.string().min(1).max(64),
  rankNumber: z.number().int().min(0).max(255),
  /** Empty when the group rank could not be read; never a stand-in phrase. */
  rankName: z.string().max(100).default(""),
  adminLevel: z.number().int().min(1).max(1000),
});

/**
 * What one running server looks like from the outside, reported on a timer and
 * whenever staff come and go. `closed` is the server saying goodbye; a server
 * that dies without one is closed by the sweep instead.
 */
export const rosterSchema = z.object({
  universeId: robloxId,
  placeId: robloxId,
  jobId: z.string().min(1).max(128),
  serverType: z.enum(SERVER_TYPES),
  playerCount: z.number().int().min(0).max(700),
  maxPlayers: z.number().int().min(0).max(700),
  closed: z.boolean().default(false),
  staff: z.array(staffPresenceSchema).max(50).default([]),
});

export type StaffPresence = z.infer<typeof staffPresenceSchema>;
export type ServerRoster = z.infer<typeof rosterSchema>;

/** How a roster is stored: Roblox IDs are strings once they are JSON. */
export type StoredStaff = {
  userId: string;
  username: string;
  rankNumber: number;
  rankName: string;
  adminLevel: number;
};

export function toStoredStaff(staff: StaffPresence[]): StoredStaff[] {
  return staff.map((member) => ({ ...member, userId: member.userId.toString() }));
}

/**
 * Reads a stored roster back. It is a JSON column written by an older build as
 * easily as by this one, so anything that does not look like a staff member is
 * dropped rather than trusted.
 */
export function readStoredStaff(value: unknown): StoredStaff[] {
  if (!Array.isArray(value)) return [];
  return value.filter((member): member is StoredStaff =>
    typeof member === "object" && member !== null
    && typeof (member as StoredStaff).userId === "string"
    && typeof (member as StoredStaff).username === "string"
    && typeof (member as StoredStaff).adminLevel === "number");
}
