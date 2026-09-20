import type { CommandRisk } from "@prisma/client";
import { STAFF_TIERS } from "./staff-ladder.js";

/**
 * How dangerous a command is, taken from the Adonis permission level it
 * demands rather than from a list somebody has to keep up to date: raising a
 * command's level in `Server-Command_Restrictor` raises its risk here too.
 *
 * What a risk is called and what colour it carries is not this feature's alone
 * — a shift record summarises the same risks — so both live in
 * [`src/shared/discord/risk.ts`](../../../shared/discord/risk.ts).
 */
export function riskForLevel(requiredLevel: number): CommandRisk {
  const [engineers, supervisors, managers] = STAFF_TIERS;
  if (requiredLevel <= engineers.level) return "LOW";
  if (requiredLevel <= supervisors.level) return "MEDIUM";
  if (requiredLevel <= managers.level) return "HIGH";
  return "CRITICAL";
}
