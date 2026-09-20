import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { CommandLogEntry } from "@prisma/client";
import { riskColor, riskLabel } from "../domain/risk.js";
import { minimumPresserLevel, tierName } from "../domain/staff-ladder.js";

/** Namespace for every component this feature owns. */
export const CUSTOM_ID_PREFIX = "cmdlog";

export const ACTIONS = { disable: "disable" } as const;

export function commandLogCustomId(action: string, entryId: string): string {
  return `${CUSTOM_ID_PREFIX}:${action}:${entryId}`;
}

/** Reads a press back. Returns null for anything this feature does not own. */
export function parseCommandLogCustomId(customId: string): { action: string; entryId: string } | null {
  const [prefix, action, entryId] = customId.split(":");
  if (prefix !== CUSTOM_ID_PREFIX || !action || !entryId) return null;
  return { action, entryId };
}

function timestamp(date: Date, style: "f" | "R"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

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
  /** Set once somebody has taken this person's command access away. */
  blockedUntil?: Date | null;
  blockedBy?: string | null;
};

/**
 * One command run. The command itself is the title, because that is what a
 * reader scanning a thread is looking for; everything that qualifies it — who,
 * what rank, how risky, which server — sits underneath in one row of fields.
 */
export function commandLogEmbed(entry: CommandLogEntry, view: CommandLogView): EmbedBuilder {
  const staff = view.discordUserId
    ? `**${entry.robloxUsername}**\n<@${view.discordUserId}>`
    : `**${entry.robloxUsername}**`;
  const embed = new EmbedBuilder()
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
    .setFooter({ text: `${entry.commandAlias} · ${entry.commandName} · place ${entry.placeId}` })
    .setTimestamp(entry.occurredAt);
  if (view.blockedUntil) {
    embed.addFields({
      name: "🔒 Command access",
      value: `Disabled until ${timestamp(view.blockedUntil, "f")} (${timestamp(view.blockedUntil, "R")})${view.blockedBy ? ` by ${view.blockedBy}` : ""}`,
      inline: false,
    });
  }
  return embed;
}

/**
 * The join link uses the same URL the session messages do, so one click lands
 * in that exact server. A Studio playtest has nothing to join.
 */
export function commandLogComponents(entry: CommandLogEntry, view: CommandLogView): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (entry.serverType === "PUBLIC") {
    buttons.push(new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Join server")
      .setURL(`https://www.roblox.com/games/start?placeId=${entry.placeId}&gameInstanceId=${encodeURIComponent(entry.jobId)}`));
  }
  buttons.push(view.blockedUntil
    ? new ButtonBuilder()
      .setCustomId(commandLogCustomId(ACTIONS.disable, entry.id))
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Access disabled")
      .setDisabled(true)
    : new ButtonBuilder()
      .setCustomId(commandLogCustomId(ACTIONS.disable, entry.id))
      .setStyle(ButtonStyle.Danger)
      .setLabel("Disable access 15m"));
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

/** What the press needs, spelled out for the person who is not allowed to. */
export function disableRequirement(entry: CommandLogEntry): string {
  const required = minimumPresserLevel(entry.adminLevel);
  return `${tierName(required)} or above (level ${required}) can disable a ${tierName(entry.adminLevel)} command run`;
}
