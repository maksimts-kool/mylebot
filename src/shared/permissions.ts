/**
 * The bot's access levels. Pure on purpose: the server half stores which
 * Discord roles grant which level, and the bot half reads a member's roles off
 * the interaction, so both import these without pulling in either side.
 */
export const PermissionLevel = {
  EVERYONE: 1,
  STAFF: 2,
  ADMIN: 3,
  MANAGER: 4,
} as const;

export function permissionLabel(level: number): string {
  return level === PermissionLevel.MANAGER ? "Manager" : level === PermissionLevel.ADMIN ? "Admin" : "Staff";
}

/** Access is cumulative: the highest level of any configured role, and never below Everyone. */
export function highestLevel(levels: Iterable<number>): number {
  return Math.max(PermissionLevel.EVERYONE, ...levels);
}
