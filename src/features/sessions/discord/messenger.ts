import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError, EmbedBuilder, RESTJSONErrorCodes,
  type Client, type TextChannel,
} from "discord.js";
import type { SessionState } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import { errorType } from "../../../core/errors.js";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import { riskLabel } from "../../../shared/discord/risk.js";
import { topCommandsLine } from "../../../shared/staff-activity.js";
import { badgeByKey } from "../domain/badges.js";
import type {
  BadgeDm, DiscordMessageReference, SessionAnnouncementView, SessionMessageView, SessionRecordView, SessionsBotPort, UpsertResult,
} from "../link.js";
import { friendlyDuration } from "./commands/format.js";
import { renderBadgeIcon } from "./profile-card.js";
import { awardSentence } from "./profile-view.js";
import { statusColor, statusIcon, statusName } from "./session-embed.js";

type MessagePayload = {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

/** Discord allows ten embeds on one message. */
const EMBEDS_PER_MESSAGE = 10;

/** Errors that mean this person can never be reached, so retrying is pointless. */
const UNREACHABLE = new Set<number>([RESTJSONErrorCodes.CannotSendMessagesToThisUser, RESTJSONErrorCodes.UnknownUser]);

function messageState(view: { state: SessionState; deletedAt: Date | null }): string {
  if (view.deletedAt) return "removed";
  return view.state === "ENDED" ? "ended" : "live";
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function timestamp(date: Date, style: "f" | "R"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function buildSessionActionRow(session: {
  id: string;
  identityId: string;
  state: SessionState;
  placeId: string | bigint;
  jobId: string;
}): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(session.state !== "ENDED" ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Join Server").setURL(`https://www.roblox.com/games/start?placeId=${session.placeId}&gameInstanceId=${encodeURIComponent(session.jobId)}`)] : []),
    new ButtonBuilder().setCustomId(`history:${session.identityId}`).setStyle(ButtonStyle.Secondary).setLabel("View History"),
    ...(session.state !== "ENDED" ? [new ButtonBuilder().setCustomId(`refresh:${session.id}`).setStyle(ButtonStyle.Primary).setLabel("Refresh")] : []),
  );
}

/**
 * The staff-chat announcement stays deliberately short; everything
 * `/session active` would show sits behind this button instead.
 */
export function buildAnnouncementActionRow(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`details:${sessionId}`).setStyle(ButtonStyle.Primary).setLabel("More info"),
  );
}

/** The full, permanent record of a shift in the session logs channel. */
export function renderSessionRecord(view: SessionRecordView): MessagePayload {
  const username = view.discordUserId ? `${view.robloxUsername} (<@${view.discordUserId}>)` : view.robloxUsername;
  const fields = [
    { name: "Information", value: "​", inline: false },
    { name: `${statusIcon(view.state)} Status`, value: statusName(view.state), inline: true },
    { name: "👤 Username", value: username, inline: true },
    { name: "📎 Rank", value: view.rankName, inline: true },
    { name: "Activity", value: "​", inline: false },
    { name: "Total time", value: formatClock(view.totals.totalMs), inline: true },
    { name: "Active time", value: formatClock(view.totals.activeMs), inline: true },
    { name: "Inactive time", value: formatClock(view.totals.inactiveMs), inline: true },
  ];
  // Nothing on record is what the record then says, rather than a zero that
  // reads like idleness.
  if (view.commands.total && view.commands.highestRisk) {
    fields.push(
      { name: "Commands", value: "​", inline: false },
      { name: "Commands run", value: String(view.commands.total), inline: true },
      { name: "Highest risk", value: riskLabel(view.commands.highestRisk), inline: true },
      { name: "Most used", value: topCommandsLine(view.commands), inline: true },
    );
  }
  if (view.history) {
    fields.push(
      { name: "History", value: "​", inline: false },
      { name: `Total time (${view.history.reportYear})`, value: formatClock(view.history.yearMs), inline: true },
      { name: "Previous session", value: view.history.previousEndedAt ? timestamp(view.history.previousEndedAt, "f") : "No previous session", inline: true },
    );
  }
  const embed = new EmbedBuilder()
    .setTitle(`${view.deletedAt ? "Removed staff session" : "Staff session"} · ${view.sessionId}`)
    .setDescription(`Started: ${timestamp(view.startedAt, "f")} | Updated: ${timestamp(view.lastEventAt, "R")}`)
    .setColor(statusColor(view.state))
    .addFields(fields);
  return {
    // The log message carries no mention; an empty content also clears one
    // left behind by an earlier build.
    content: "",
    embeds: [embed],
    components: view.deletedAt ? [] : [buildSessionActionRow({
      id: view.sessionId, identityId: view.identityId, state: view.state, placeId: view.placeId, jobId: view.jobId,
    })],
  };
}

/**
 * A single short message in the staff chat channel: the member is mentioned
 * outside the embed when their shift starts, and that same message is edited
 * when it ends.
 */
export function renderSessionAnnouncement(view: SessionAnnouncementView): MessagePayload {
  const ended = view.state === "ENDED";
  const name = `**${view.robloxUsername}**`;
  const started = timestamp(view.startedAt, "R");
  const embed = new EmbedBuilder()
    .setFooter({ text: `Session ${view.sessionId}` })
    .setColor(view.deletedAt ? statusColor("ENDED") : statusColor(view.state));
  if (view.deletedAt) {
    embed.setTitle("🗑️ Session removed").setDescription(`${name}'s shift was removed from the statistics.`);
  } else if (ended) {
    embed
      .setTitle("✅ Session ended")
      .setDescription([
        `${name} finished their shift.`,
        `⏱️ ${friendlyDuration(view.totals.totalMs)} total · ${friendlyDuration(view.totals.activeMs)} active`,
        `🗓️ Started ${started}${view.endedAt ? ` · ended ${timestamp(view.endedAt, "R")}` : ""}`,
      ].join("\n"));
  } else {
    embed
      .setTitle("🟢 Session started")
      .setDescription(`${name} is on shift.\n🗓️ Started ${started}`);
  }
  return {
    content: view.discordUserId ? `<@${view.discordUserId}>` : view.robloxUsername,
    embeds: [embed],
    components: view.deletedAt ? [] : [buildAnnouncementActionRow(view.sessionId)],
  };
}

/**
 * Session tracking's hands in Discord. The server half decides what each
 * message says and which message a session owns; this posts, edits and takes
 * messages down, and says what it did.
 */
export class SessionMessenger {
  private readonly log: Logger;

  constructor(private readonly client: Client, private readonly config: Config, log: Logger) {
    this.log = log.child({ category: "discord" });
  }

  private requireReady(): void {
    if (!this.client.isReady()) throw new LinkUnavailableError("Discord is not connected");
  }

  async removeMessages(messages: DiscordMessageReference[]): Promise<void> {
    if (!messages.length) return;
    this.requireReady();
    for (const { channelId, messageId } of messages) {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel;
        await channel.messages.delete(messageId);
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === 10008) continue;
        this.log.error({ err: error, errorType: errorType(error), messageId }, "Message removal failed");
      }
    }
  }

  /**
   * Edits the message the session already owns, or posts a new one. A message
   * that moved channel, or that somebody deleted, is replaced rather than
   * treated as an error.
   */
  async upsertMessage(channelId: string, existing: DiscordMessageReference | null, view: SessionMessageView): Promise<UpsertResult> {
    this.requireReady();
    const payload = view.kind === "record" ? renderSessionRecord(view) : renderSessionAnnouncement(view);
    const what = view.kind === "record" ? "session record" : "shift announcement";
    const state = messageState(view);
    // The announcement is only ever edited when a shift settles, so each edit is
    // news. The record is edited on every refresh, which is not.
    const editsAreNews = view.kind === "announcement";
    const channel = await this.client.channels.fetch(channelId) as TextChannel;
    const fields = { actor: view.robloxUsername, sessionId: view.sessionId, channel: channel.name ? `#${channel.name}` : undefined };
    if (existing) {
      if (existing.channelId !== channel.id) {
        await this.removeMessages([existing]);
      } else {
        try {
          // Editing by id is one call; fetching the message first would be two
          // for every live session on every refresh.
          await channel.messages.edit(existing.messageId, payload);
          this.log[editsAreNews ? "info" : "debug"](fields, `Updated the ${what}: ${state}`);
          return { status: "edited" };
        } catch (error) {
          if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
        }
      }
    }
    const message = await channel.send(payload);
    this.log.info(fields, existing ? `Reposted the ${what}, the old message was gone: ${state}` : `Posted the ${what}: ${state}`);
    return { status: "posted", channelId: channel.id, messageId: message.id };
  }

  /** Tells one member about badges they earned, in one DM. */
  async sendBadgeDm(dm: BadgeDm): Promise<"sent" | "unreachable" | "skipped"> {
    this.requireReady();
    const shown = dm.awards.slice(0, EMBEDS_PER_MESSAGE);
    const files: AttachmentBuilder[] = [];
    const embeds: EmbedBuilder[] = [];
    for (const [index, award] of shown.entries()) {
      const badge = badgeByKey(award.badge);
      if (!badge) continue;
      const name = `badge-${index}.png`;
      files.push(new AttachmentBuilder(await renderBadgeIcon(badge, 128), { name }));
      embeds.push(new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle(`${badge.emoji} New badge: ${badge.name}`)
        .setDescription(awardSentence(badge, award.period, dm.activeMs, this.config.REPORT_TIMEZONE))
        .setThumbnail(`attachment://${name}`)
        .setFooter({ text: "Use /profile to see all your badges" }));
    }
    if (!embeds.length) return "skipped";
    try {
      await this.client.users.send(dm.discordUserId, { embeds, files });
      this.log.info({ actor: dm.robloxUsername, badges: shown.map(({ badge }) => badge).join(", ") }, "Told a member about a new badge");
      return "sent";
    } catch (error) {
      if (error instanceof DiscordAPIError && typeof error.code === "number" && UNREACHABLE.has(error.code)) {
        this.log.debug({ actor: dm.robloxUsername }, "Could not DM a member about a badge; their DMs are closed");
        return "unreachable";
      }
      throw error;
    }
  }

  /** The port the server half calls. */
  port(): SessionsBotPort {
    return {
      upsertMessage: (channelId, existing, view) => this.upsertMessage(channelId, existing, view),
      removeMessages: (messages) => this.removeMessages(messages),
      sendBadgeDm: (dm) => this.sendBadgeDm(dm),
    };
  }
}
