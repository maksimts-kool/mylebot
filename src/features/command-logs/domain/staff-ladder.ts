/**
 * The staff ladder, mirrored from the place's Adonis settings so Discord and
 * the game agree on who outranks whom.
 *
 * Adonis matches `Group:<id>:<rank>` on the exact rank number, which is why
 * Managers lists two ranks rather than a range. Change these together with
 * `Adonis_Loader.Config.Settings` — they are two copies of one ladder, and a
 * rank that is missing here simply holds no staff tier.
 */
export const STAFF_TIERS = [
  { level: 101, name: "Engineers", groupRanks: [7] },
  { level: 201, name: "Supervisors", groupRanks: [9] },
  { level: 250, name: "Managers", groupRanks: [10, 254] },
] as const;

/**
 * The highest tier anybody actually holds. Adonis defines Directors (301) and
 * Creators (900) above Managers, but no one is in either, so a Manager-run
 * command is disabled by another Manager rather than by nobody.
 */
export const TOP_TIER_LEVEL = 250;

/** The tier a group rank grants, or 0 for a rank that holds no tier. */
export function levelForGroupRank(rank: number): number {
  const tier = STAFF_TIERS.find(({ groupRanks }) => (groupRanks as readonly number[]).includes(rank));
  return tier?.level ?? 0;
}

/** What a tier is called, for a level that may sit between or above the tiers. */
export function tierName(level: number): string {
  if (level >= 900) return "Creators";
  if (level >= 301) return "Directors";
  const tier = [...STAFF_TIERS].reverse().find((candidate) => level >= candidate.level);
  return tier?.name ?? "Players";
}

/**
 * The level somebody needs to take command access away from a run at
 * `runnerLevel`. Pressing is one tier up — an Engineers run needs a
 * Supervisor, a Supervisors run needs a Manager — and stops at the top tier,
 * because nothing above Managers is staffed.
 */
export function minimumPresserLevel(runnerLevel: number): number {
  const above = STAFF_TIERS.find(({ level }) => level > runnerLevel);
  return above ? above.level : TOP_TIER_LEVEL;
}
