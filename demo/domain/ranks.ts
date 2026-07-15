// Pure rank model + governance. No I/O, fully unit-testable.

export type Track = "SURFER" | "ENGINEER" | "MANAGEMENT";
export type RankCode = "LS" | "LE" | "SS" | "ES" | "SM";

// Mirrors the production PermissionLevel in src/discord/commands.ts so the demo
// slots into the same cumulative STAFF < ADMIN < MANAGER model.
export const PermissionLevel = { EVERYONE: 1, STAFF: 2, ADMIN: 3, MANAGER: 4 } as const;
export type PermissionLevelValue = (typeof PermissionLevel)[keyof typeof PermissionLevel];

export interface RankDef {
  code: RankCode;
  label: string;
  short: string;
  track: Track;
  /** Seniority. Higher outranks lower. LS/LE=1, SS/ES=2, SM=3. */
  order: number;
  hirable: boolean;
  botLevel: PermissionLevelValue;
}

export const RANKS: Record<RankCode, RankDef> = {
  LS: { code: "LS", label: "Lift Surfer", short: "LS", track: "SURFER", order: 1, hirable: true, botLevel: PermissionLevel.STAFF },
  LE: { code: "LE", label: "Lift Engineer", short: "LE", track: "ENGINEER", order: 1, hirable: true, botLevel: PermissionLevel.STAFF },
  SS: { code: "SS", label: "Surfers Supervisor", short: "SS", track: "SURFER", order: 2, hirable: false, botLevel: PermissionLevel.ADMIN },
  ES: { code: "ES", label: "Engineers Supervisor", short: "ES", track: "ENGINEER", order: 2, hirable: false, botLevel: PermissionLevel.ADMIN },
  SM: { code: "SM", label: "Staff Manager", short: "SM", track: "MANAGEMENT", order: 3, hirable: false, botLevel: PermissionLevel.MANAGER },
};

export const RANK_CODES: RankCode[] = ["LS", "LE", "SS", "ES", "SM"];

export function isRankCode(value: string): value is RankCode {
  return (RANK_CODES as string[]).includes(value);
}

export function rank(code: RankCode): RankDef {
  return RANKS[code];
}

/** The entry rank a track hires into. */
export function entryRankForTrack(track: "SURFER" | "ENGINEER"): "LS" | "LE" {
  return track === "SURFER" ? "LS" : "LE";
}

/**
 * Can `actor` create/change a member to sit at rank `target`?
 * - SM manages everyone strictly below SM.
 * - SS manages the Surfer track strictly below SS (i.e. LS).
 * - ES manages the Engineer track strictly below ES (i.e. LE).
 * Nobody can touch a rank at or above their own.
 */
export function canManageRank(actor: RankDef, target: RankDef): boolean {
  if (target.order >= actor.order) return false;
  if (actor.code === "SM") return true;
  if (actor.code === "SS") return target.track === "SURFER";
  if (actor.code === "ES") return target.track === "ENGINEER";
  return false;
}

/** A rank change is allowed only if the actor may manage both the old and the new rank. */
export function canSetRank(actor: RankDef, current: RankDef, next: RankDef): boolean {
  return canManageRank(actor, current) && canManageRank(actor, next);
}

/** Who may accept/reject an application targeting `targetRank`. */
export function canReviewApplication(actor: RankDef, targetRank: RankCode): boolean {
  const target = RANKS[targetRank];
  return canManageRank(actor, target);
}

/** Ranks `actor` could promote/demote a member currently at `current` into. */
export function assignableRanks(actor: RankDef, current: RankDef): RankDef[] {
  if (!canManageRank(actor, current)) return [];
  return RANK_CODES.map((code) => RANKS[code]).filter((next) => next.code !== current.code && canManageRank(actor, next));
}
