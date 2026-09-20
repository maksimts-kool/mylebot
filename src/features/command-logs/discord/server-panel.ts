import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { CommandLogThread } from "@prisma/client";
import { BRAND_COLOR, ENDED_COLOR } from "../../../shared/discord/colors.js";
import { compactDuration, timeIntoShift, type ShiftStatus } from "../../../shared/staff-activity.js";
import { BLOCK_MINUTES } from "../domain/policy.js";
import type { StoredStaff } from "../domain/roster.js";
import { tierName } from "../domain/staff-ladder.js";

/** Namespace for every component this feature owns. */
export const CUSTOM_ID_PREFIX = "cmdlog";

export const PANEL_ACTIONS = { disable: "disable", restore: "restore" } as const;

/** Discord allows 25 options in a select menu. */
const OPTION_LIMIT = 25;

export function panelCustomId(action: string): string {
  return `${CUSTOM_ID_PREFIX}:${action}`;
}

/** Reads a press back. Returns null for anything this feature does not own. */
export function parsePanelCustomId(customId: string): string | null {
  const [prefix, action] = customId.split(":");
  if (prefix !== CUSTOM_ID_PREFIX || !action) return null;
  return action;
}

function timestamp(date: Date, style: "f" | "R" | "t"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** When each blocked person gets their commands back, by Roblox user ID. */
export type BlockedUntil = Map<string, Date>;

/** Whether each of them is on a tracked shift, by Roblox user ID. */
export type Shifts = Map<string, ShiftStatus>;

/**
 * Whether somebody in the server is on shift, as the roster says it. Only
 * people the session tracker knows are described at all — an unknown Roblox
 * account is not "off shift", and a server full of untracked staff should read
 * no differently from one where the feature was never set up.
 */
function shiftPart(status: ShiftStatus | undefined, at: Date): string | null {
  if (!status?.tracked) return null;
  const elapsed = timeIntoShift(status, at);
  return elapsed === null ? "off shift" : `on shift ${compactDuration(elapsed)}`;
}

function staffLine(member: StoredStaff, blockedUntil: BlockedUntil, shifts: Shifts, at: Date): string {
  const blocked = blockedUntil.get(member.userId);
  // The Adonis tier is what their access actually is; the group role is only
  // ever a nicer name for it, so an unknown one is left out rather than
  // announced. Nobody needs to read "Creators · Not in group".
  const tier = member.rankName ? `${tierName(member.adminLevel)} · ${member.rankName}` : tierName(member.adminLevel);
  const parts = [tier];
  const shift = shiftPart(shifts.get(member.userId), at);
  if (shift) parts.push(shift);
  if (blocked) parts.push(`blocked until ${timestamp(blocked, "t")}`);
  return `${blocked ? "🔒 " : ""}**${member.username}** — ${parts.join(" · ")}`;
}

/**
 * One running server, kept up to date in the channel: who is in it that can
 * run commands, and what can be done about them. The command log itself lives
 * in the thread hanging off this message, so the records stay plain reading
 * and every control is in one place instead of repeated under each of them.
 */
export function serverPanelEmbed(
  server: CommandLogThread,
  staff: StoredStaff[],
  blockedUntil: BlockedUntil,
  shifts: Shifts = new Map(),
): EmbedBuilder {
  const studio = server.serverType === "STUDIO";
  const embed = new EmbedBuilder()
    .setTitle(studio ? "🧪 Studio playtest" : "🌐 Public server")
    .setColor(server.closedAt ? ENDED_COLOR : BRAND_COLOR)
    .setTimestamp(server.lastSeenAt);

  if (server.closedAt) {
    embed.setDescription([
      `This server closed ${timestamp(server.closedAt, "R")}.`,
      `Job ID \`${server.jobId}\``,
    ].join("\n"));
    return embed;
  }

  embed
    .setDescription([
      studio
        ? `Place \`${server.placeId}\``
        : `${server.playerCount}/${server.maxPlayers} players · place \`${server.placeId}\``,
      `Job ID \`${server.jobId}\``,
    ].join("\n"))
    .addFields({
      name: `👮 Staff in this server (${staff.length})`,
      value: staff.length
        // The panel shows the server as of its last report, so a shift is
        // measured to that instant rather than to whenever this was rendered.
        ? staff.map((member) => staffLine(member, blockedUntil, shifts, server.lastSeenAt)).join("\n").slice(0, 1024)
        : "Nobody with Adonis access is in this server.",
      inline: false,
    });
  return embed;
}

function pickMenu(action: string, placeholder: string, staff: StoredStaff[], blockedUntil: BlockedUntil) {
  return new StringSelectMenuBuilder()
    .setCustomId(panelCustomId(action))
    .setPlaceholder(placeholder)
    .addOptions(staff.slice(0, OPTION_LIMIT).map((member) => {
      const blocked = blockedUntil.get(member.userId);
      return {
        label: member.username.slice(0, 100),
        value: member.userId,
        description: (blocked
          ? `${tierName(member.adminLevel)} · blocked until ${blocked.toISOString().slice(11, 16)} UTC`
          : member.rankName ? `${tierName(member.adminLevel)} · ${member.rankName}` : tierName(member.adminLevel)).slice(0, 100),
      };
    }));
}

/**
 * The panel's controls: a way into the server, and a picker for each direction
 * access can be moved. A menu with nobody to offer is left off entirely, so
 * the panel never shows a control that cannot do anything.
 */
export function serverPanelComponents(
  server: CommandLogThread,
  staff: StoredStaff[],
  blockedUntil: BlockedUntil,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (server.closedAt) return [];
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  if (server.serverType === "PUBLIC") {
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Join server")
        .setURL(`https://www.roblox.com/games/start?placeId=${server.placeId}&gameInstanceId=${encodeURIComponent(server.jobId)}`),
    ));
  }

  const free = staff.filter((member) => !blockedUntil.has(member.userId));
  const blocked = staff.filter((member) => blockedUntil.has(member.userId));
  if (free.length) {
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      pickMenu(PANEL_ACTIONS.disable, `Disable command access for ${BLOCK_MINUTES} minutes`, free, blockedUntil),
    ));
  }
  if (blocked.length) {
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      pickMenu(PANEL_ACTIONS.restore, "Give command access back", blocked, blockedUntil),
    ));
  }
  return rows;
}

/** The thread the panel owns, named so a closed server is still recognisable. */
export function threadName(server: { serverType: string; jobId: string }): string {
  const label = server.serverType === "STUDIO" ? "Studio" : "Server";
  return `${label} ${server.jobId}`.slice(0, 100);
}

/** What the thread says when somebody moves a person's access from the panel. */
export function accessNotice(
  action: "disabled" | "restored",
  username: string,
  by: string,
  until?: Date,
): string {
  return action === "disabled"
    ? `🔒 ${by} disabled **${username}**'s command access for ${BLOCK_MINUTES} minutes${until ? `, until ${timestamp(until, "t")}` : ""}.`
    : `🔓 ${by} gave **${username}**'s command access back.`;
}
