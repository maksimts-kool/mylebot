import type { CommandRisk } from "@prisma/client";
import { ACTIVE_COLOR, DANGER_COLOR, INACTIVE_COLOR } from "../../../shared/discord/colors.js";
import { STAFF_TIERS } from "./staff-ladder.js";

/**
 * How dangerous a command is, taken from the Adonis permission level it
 * demands rather than from a list somebody has to keep up to date: raising a
 * command's level in `Server-Command_Restrictor` raises its risk here too.
 */
export function riskForLevel(requiredLevel: number): CommandRisk {
  const [engineers, supervisors, managers] = STAFF_TIERS;
  if (requiredLevel <= engineers.level) return "LOW";
  if (requiredLevel <= supervisors.level) return "MEDIUM";
  if (requiredLevel <= managers.level) return "HIGH";
  return "CRITICAL";
}

const RISK_LABEL: Record<CommandRisk, string> = {
  LOW: "🟢 Low", MEDIUM: "🟡 Medium", HIGH: "🟠 High", CRITICAL: "🔴 Critical",
};

/** Orange has no shared constant; the other three are the bot's own palette. */
const HIGH_COLOR = 0xe67e22;

const RISK_COLOR: Record<CommandRisk, number> = {
  LOW: ACTIVE_COLOR, MEDIUM: INACTIVE_COLOR, HIGH: HIGH_COLOR, CRITICAL: DANGER_COLOR,
};

export function riskLabel(risk: CommandRisk): string {
  return RISK_LABEL[risk];
}

export function riskColor(risk: CommandRisk): number {
  return RISK_COLOR[risk];
}
