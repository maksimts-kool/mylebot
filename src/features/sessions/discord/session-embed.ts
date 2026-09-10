import { EmbedBuilder } from "discord.js";
import type { SessionState } from "@prisma/client";
import { ACTIVE_COLOR, ENDED_COLOR, INACTIVE_COLOR } from "../../../shared/discord/colors.js";
import { totalsForPeriod, type SegmentLike } from "../domain/accounting.js";
import { friendlyDuration } from "./commands/format.js";

/**
 * Reconnect grace periods were removed, so nothing enters `RECONNECTING` any
 * more. The state is still in the database enum for historical rows, so it is
 * presented exactly like a finished session.
 */
const STATUS_NAME: Record<SessionState, string> = {
  ACTIVE: "Active", INACTIVE: "Inactive", RECONNECTING: "Ended", ENDED: "Ended",
};
const STATUS_LIVE_NAME: Record<SessionState, string> = {
  ACTIVE: "Active now", INACTIVE: "Inactive now", RECONNECTING: "Completed", ENDED: "Completed",
};
const STATUS_ICON: Record<SessionState, string> = {
  ACTIVE: "🟢", INACTIVE: "🟡", RECONNECTING: "✅", ENDED: "✅",
};
const STATUS_COLOR: Record<SessionState, number> = {
  ACTIVE: ACTIVE_COLOR, INACTIVE: INACTIVE_COLOR, RECONNECTING: ENDED_COLOR, ENDED: ENDED_COLOR,
};

export function statusName(state: SessionState): string {
  return STATUS_NAME[state];
}

export function statusLabel(state: SessionState): string {
  return STATUS_LIVE_NAME[state];
}

export function statusIcon(state: SessionState): string {
  return STATUS_ICON[state];
}

export function statusColor(state: SessionState): number {
  return STATUS_COLOR[state];
}

export type SessionDetail = {
  id: string;
  state: SessionState;
  startedAt: Date;
  endedAt: Date | null;
  jobId: string;
  rankName: string;
  segments: SegmentLike[];
  identity: { robloxUsername: string; discordUserId: string | null };
};

export function discordTimestamp(date: Date, style: "f" | "R"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** `RobloxName · @member`, or just the Roblox name when nothing is linked. */
export function sessionOwner(identity: { robloxUsername: string; discordUserId: string | null }): string {
  return identity.discordUserId
    ? `**${identity.robloxUsername}** · <@${identity.discordUserId}>`
    : `**${identity.robloxUsername}**`;
}

/**
 * The full picture of one session. `/session active user:<member>` replies with
 * this, and so does the details button on a published session message, so both
 * surfaces always agree.
 */
export function sessionDetailEmbed(session: SessionDetail, now = new Date()): EmbedBuilder {
  const end = session.endedAt ?? now;
  const totals = totalsForPeriod(session.segments, session.startedAt, end, end);
  const embed = new EmbedBuilder()
    .setTitle(`${statusIcon(session.state)} ${statusLabel(session.state)}`)
    .setDescription(`👤 ${sessionOwner(session.identity)}`)
    .setColor(statusColor(session.state))
    .addFields(
      { name: "🗓️ Started", value: discordTimestamp(session.startedAt, "R"), inline: true },
      session.endedAt
        ? { name: "🏁 Ended", value: discordTimestamp(session.endedAt, "R"), inline: true }
        : { name: "🖥️ Server", value: `\`${session.jobId}\``, inline: true },
      { name: "📎 Rank", value: session.rankName, inline: true },
      {
        name: session.endedAt ? "⏱️ Time recorded" : "⏱️ Time so far",
        value: `${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active · ${friendlyDuration(totals.inactiveMs)} inactive`,
        inline: false,
      },
      { name: "🆔 Session ID", value: `\`${session.id}\``, inline: false },
    );
  return embed;
}
