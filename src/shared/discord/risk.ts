import type { CommandRisk } from "@prisma/client";
import { ACTIVE_COLOR, DANGER_COLOR, INACTIVE_COLOR } from "./colors.js";

/**
 * How a command's risk is named and coloured. The risk itself is the command
 * log's to decide, but both the command records and the shift records built
 * from them show it, so the wording lives here and the two always agree.
 */

const RISK_LABEL: Record<CommandRisk, string> = {
  LOW: "🟢 Low", MEDIUM: "🟡 Medium", HIGH: "🟠 High", CRITICAL: "🔴 Critical",
};

/** Orange has no shared constant; the other three are the bot's own palette. */
const HIGH_COLOR = 0xe67e22;

const RISK_COLOR: Record<CommandRisk, number> = {
  LOW: ACTIVE_COLOR, MEDIUM: INACTIVE_COLOR, HIGH: HIGH_COLOR, CRITICAL: DANGER_COLOR,
};

/** Worst first, which is the order anything summarising a run of them reads in. */
export const RISK_ORDER: readonly CommandRisk[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

export function riskLabel(risk: CommandRisk): string {
  return RISK_LABEL[risk];
}

export function riskColor(risk: CommandRisk): number {
  return RISK_COLOR[risk];
}
