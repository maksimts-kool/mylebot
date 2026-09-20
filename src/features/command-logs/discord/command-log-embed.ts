import { EmbedBuilder } from "discord.js";
import type { CommandLogEntry } from "@prisma/client";
import { riskColor, riskLabel } from "../domain/risk.js";
import { tierName } from "../domain/staff-ladder.js";

/**
 * Their group rank, and the Adonis level it earns them. An unknown rank — the
 * lookup failed, or they hold their access some other way — shows the level
 * alone rather than a phrase standing in for a rank name.
 */
function rankValue(entry: CommandLogEntry): string {
  const level = entry.rankNumber
    ? `rank ${entry.rankNumber} · level ${entry.adminLevel}`
    : `level ${entry.adminLevel}`;
  return entry.rankName ? `${entry.rankName}\n${level}` : level;
}

/** Who the command resolved to, or nothing when it took no players. */
function targetsValue(targets: string[]): string {
  if (targets.length <= 4) return targets.join(", ");
  return `${targets.slice(0, 4).join(", ")} and ${targets.length - 4} more`;
}

export type CommandLogView = {
  /** The Discord account the runner is linked to, when Bloxlink knows one. */
  discordUserId: string | null;
};

/**
 * One command run. The command itself is the title, because that is what a
 * reader scanning a thread is looking for; who ran it, at what rank, how risky
 * it was and who it hit sit underneath in one row of fields.
 *
 * Which server this was is deliberately absent, as is the job id: every record
 * in the thread would repeat what the panel the thread hangs off already says
 * once. For the same reason the record carries no buttons — the panel owns
 * every control, so nobody acts on a command from minutes ago when they mean
 * to act on the server as it is now.
 */
export function commandLogEmbed(entry: CommandLogEntry, view: CommandLogView): EmbedBuilder {
  const staff = view.discordUserId
    ? `**${entry.robloxUsername}**\n<@${view.discordUserId}>`
    : `**${entry.robloxUsername}**`;
  return new EmbedBuilder()
    .setAuthor({ name: `Adonis command · ${tierName(entry.adminLevel)}` })
    .setTitle(entry.commandText.slice(0, 256))
    .setColor(riskColor(entry.risk))
    .addFields(
      { name: "👤 Staff", value: staff, inline: true },
      { name: "📎 Rank", value: rankValue(entry), inline: true },
      { name: "⚠️ Risk", value: `${riskLabel(entry.risk)}\nrequires ${entry.requiredLevel}`, inline: true },
      ...(entry.targets.length
        ? [{ name: "🎯 Ran on", value: targetsValue(entry.targets), inline: false }]
        : []),
    )
    // Nothing else belongs in the footer: the command is already the title, and
    // the place is on the server's own panel. The timestamp is what a reader
    // scanning a thread actually needs, rendered in their own timezone.
    .setTimestamp(entry.occurredAt);
}
