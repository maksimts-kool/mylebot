import { EmbedBuilder } from "discord.js";
import type { CommandLogEntry } from "@prisma/client";
import { riskColor, riskLabel } from "../domain/risk.js";
import { tierName } from "../domain/staff-ladder.js";

/** `Public · 14/30`, or just `Studio` for a playtest that has no player limit. */
function serverValue(entry: CommandLogEntry): string {
  if (entry.serverType === "STUDIO") return "🧪 Studio playtest";
  return `🌐 Public · ${entry.playerCount}/${entry.maxPlayers}`;
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
 * reader scanning a thread is looking for; everything that qualifies it — who,
 * what rank, how risky, which server — sits underneath in one row of fields.
 *
 * It carries no buttons. Every record in a thread would have shown the same
 * two, which reads as clutter and invites acting on a command from minutes ago
 * rather than on the server as it is now; the panel the thread hangs off owns
 * the controls instead.
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
      { name: "📎 Rank", value: `${entry.rankName}\nrank ${entry.rankNumber} · level ${entry.adminLevel}`, inline: true },
      { name: "⚠️ Risk", value: `${riskLabel(entry.risk)}\nrequires ${entry.requiredLevel}`, inline: true },
      { name: "🖥️ Server", value: serverValue(entry), inline: true },
      ...(entry.targets.length
        ? [{ name: "🎯 Ran on", value: targetsValue(entry.targets), inline: true }]
        : []),
      { name: "🆔 Job ID", value: `\`${entry.jobId}\``, inline: false },
    )
    // Nothing else belongs in the footer: the command is already the title, and
    // the place is on the server's own panel. The timestamp is what a reader
    // scanning a thread actually needs, rendered in their own timezone.
    .setTimestamp(entry.occurredAt);
}
