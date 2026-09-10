import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, DiscordAPIError, EmbedBuilder, type TextChannel,
} from "discord.js";
import type { SessionState } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";
import { totalsForPeriod } from "../domain/accounting.js";
import { calendarYearRange } from "../domain/reporting.js";
import { MINIMUM_SESSION_MILLISECONDS, announcementRetentionElapsed, sessionMeetsMinimum } from "../domain/policy.js";
import type { DiscordMessageReference } from "../service/session-service.js";
import { friendlyDuration } from "./commands/format.js";
import { statusColor, statusIcon, statusName } from "./session-embed.js";

type MessagePayload = {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
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

export class DiscordPublisher {
  private readonly pendingMessageRemovals: DiscordMessageReference[] = [];

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly bloxlink: BloxlinkService,
    private readonly settings: RuntimeSettingsService,
  ) {}

  async refreshMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.refresh(id).catch((error) => console.error(`Discord refresh failed for ${id}`, error));
  }

  /**
   * Takes messages down, or queues them for `restore` when Discord is not
   * connected. The return says which happened, so a caller that is about to
   * forget the messages can wait for a pass that actually removed them.
   */
  async removeMessages(messages: DiscordMessageReference[]): Promise<boolean> {
    if (!messages.length) return true;
    if (!this.client.isReady()) {
      this.pendingMessageRemovals.push(...messages);
      return false;
    }
    for (const { channelId, messageId } of messages) {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel;
        await channel.messages.delete(messageId);
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === 10008) continue;
        console.error(`Discord message deletion failed for ${messageId}`, error);
      }
    }
    return true;
  }

  async refresh(sessionId: string, includeDeleted = false): Promise<void> {
    const settings = await this.settings.get();
    if (!this.client.isReady() || (!settings.logsChannelId && !settings.staffChannelId)) return;
    const session = await this.db.session.findUnique({
      where: { id: sessionId }, include: { identity: true, segments: true, discordMessage: true, announcement: true },
    });
    if (!session || (session.deletedAt && !includeDeleted)) return;
    // Accounting stops at the end of the shift; the announcement's retention is
    // measured against the wall clock, so the two instants are kept apart.
    const at = new Date();
    const now = session.endedAt ?? at;
    const totals = totalsForPeriod(session.segments, session.startedAt, now, now);

    // A record too short to count is not a record at all: take both of its
    // messages back down rather than leaving them behind.
    if (session.state === "ENDED" && totals.totalMs < MINIMUM_SESSION_MILLISECONDS) {
      const stale = [session.discordMessage, session.announcement].filter((message) => message !== null);
      if (stale.length) {
        await this.removeMessages(stale.map(({ channelId, messageId }) => ({ channelId, messageId })));
        await this.db.discordMessage.deleteMany({ where: { sessionId: session.id } });
        await this.db.sessionAnnouncement.deleteMany({ where: { sessionId: session.id } });
      }
      return;
    }

    if (settings.logsChannelId) await this.publishLog(session, settings.logsChannelId, totals, now);
    if (settings.staffChannelId) await this.publishAnnouncement(session, settings.staffChannelId, totals, at);
  }

  /** The full, permanent record of a shift in the session logs channel. */
  private async publishLog(
    session: SessionRecord,
    logsChannelId: string,
    totals: { totalMs: number; activeMs: number; inactiveMs: number },
    now: Date,
  ): Promise<void> {
    const discordUserId = session.identity.discordUserId ?? await this.bloxlink.discordForRoblox(session.identity.robloxUserId);
    const username = discordUserId
      ? `${session.identity.robloxUsername} (<@${discordUserId}>)`
      : session.identity.robloxUsername;
    const fields = [
      { name: "Information", value: "​", inline: false },
      { name: `${statusIcon(session.state)} Status`, value: statusName(session.state), inline: true },
      { name: "👤 Username", value: username, inline: true },
      { name: "📎 Rank", value: session.rankName, inline: true },
      { name: "Activity", value: "​", inline: false },
      { name: "Total time", value: formatClock(totals.totalMs), inline: true },
      { name: "Active time", value: formatClock(totals.activeMs), inline: true },
      { name: "Inactive time", value: formatClock(totals.inactiveMs), inline: true },
    ];
    if (session.state === "ENDED") {
      const year = calendarYearRange(now, this.config.REPORT_TIMEZONE);
      const reportYear = new Intl.DateTimeFormat("en", { timeZone: this.config.REPORT_TIMEZONE, year: "numeric" }).format(now);
      const yearSessions = await this.db.session.findMany({
        where: { identityId: session.identityId, deletedAt: null, startedAt: { lt: year.end }, OR: [{ endedAt: null }, { endedAt: { gt: year.start } }] },
        include: { segments: true },
      });
      const yearMs = yearSessions
        .filter((item) => sessionMeetsMinimum(item, now))
        .reduce((sum, item) => sum + totalsForPeriod(item.segments, year.start, year.end, now).totalMs, 0);
      const previous = (await this.db.session.findMany({
        where: { identityId: session.identityId, id: { not: session.id }, deletedAt: null, endedAt: { lt: session.startedAt } },
        include: { segments: true },
        orderBy: { endedAt: "desc" },
      })).find((item) => sessionMeetsMinimum(item, now));
      fields.push(
        { name: "History", value: "​", inline: false },
        { name: `Total time (${reportYear})`, value: formatClock(yearMs), inline: true },
        { name: "Previous session", value: previous?.endedAt ? `<t:${Math.floor(previous.endedAt.getTime() / 1000)}:f>` : "No previous session", inline: true },
      );
    }
    const embed = new EmbedBuilder()
      .setTitle(`${session.deletedAt ? "Removed staff session" : "Staff session"} · ${session.id}`)
      .setDescription(`Started: <t:${Math.floor(session.startedAt.getTime() / 1000)}:f> | Updated: <t:${Math.floor(session.lastEventAt.getTime() / 1000)}:R>`)
      .setColor(statusColor(session.state))
      .addFields(fields);
    await this.publish(
      session.discordMessage,
      logsChannelId,
      // The log message carries no mention; an empty content also clears one
      // left behind by an earlier build.
      { content: "", embeds: [embed], components: session.deletedAt ? [] : [buildSessionActionRow(session)] },
      (channelId, messageId) => this.db.discordMessage.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, channelId, messageId },
        update: { channelId, messageId },
      }).then(() => undefined),
    );
  }

  /**
   * A single short message in the staff chat channel: the member is mentioned
   * outside the embed when their shift starts, and that same message is edited
   * when it ends. Nothing about it changes while the shift is running, so a
   * live session is left alone instead of being edited on every refresh.
   *
   * The announcement is temporary — the `announcement cleanup` job takes it
   * down once the shift has been settled for its retention window — so past
   * that point this publishes nothing rather than reposting an old shift.
   */
  private async publishAnnouncement(
    session: SessionRecord,
    staffChannelId: string,
    totals: { totalMs: number; activeMs: number },
    now: Date,
  ): Promise<void> {
    const ended = session.state === "ENDED";
    const settled = ended || session.deletedAt !== null;
    if (session.announcement && !settled) return;
    if (settled && announcementRetentionElapsed(session, now)) return;

    const discordUserId = session.identity.discordUserId ?? await this.bloxlink.discordForRoblox(session.identity.robloxUserId);
    const name = `**${session.identity.robloxUsername}**`;
    const started = `<t:${Math.floor(session.startedAt.getTime() / 1000)}:R>`;
    const embed = new EmbedBuilder()
      .setFooter({ text: `Session ${session.id}` })
      .setColor(session.deletedAt ? statusColor("ENDED") : statusColor(session.state));
    if (session.deletedAt) {
      embed.setTitle("🗑️ Session removed").setDescription(`${name}'s shift was removed from the statistics.`);
    } else if (ended) {
      embed
        .setTitle("✅ Session ended")
        .setDescription([
          `${name} finished their shift.`,
          `⏱️ ${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active`,
          `🗓️ Started ${started}${session.endedAt ? ` · ended <t:${Math.floor(session.endedAt.getTime() / 1000)}:R>` : ""}`,
        ].join("\n"));
    } else {
      embed
        .setTitle("🟢 Session started")
        .setDescription(`${name} is on shift.\n🗓️ Started ${started}`);
    }

    await this.publish(
      session.announcement,
      staffChannelId,
      {
        content: discordUserId ? `<@${discordUserId}>` : session.identity.robloxUsername,
        embeds: [embed],
        components: session.deletedAt ? [] : [buildAnnouncementActionRow(session.id)],
      },
      (channelId, messageId) => this.db.sessionAnnouncement.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, channelId, messageId },
        update: { channelId, messageId },
      }).then(() => undefined),
    );
  }

  /**
   * Edits the message the session already owns, or posts a new one. A message
   * that moved channel, or that somebody deleted, is replaced rather than
   * treated as an error.
   */
  private async publish(
    existing: { channelId: string; messageId: string } | null,
    channelId: string,
    payload: MessagePayload,
    save: (channelId: string, messageId: string) => Promise<void>,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId) as TextChannel;
    if (existing) {
      if (existing.channelId !== channel.id) {
        await this.removeMessages([{ channelId: existing.channelId, messageId: existing.messageId }]);
      } else {
        try {
          const message = await channel.messages.fetch(existing.messageId);
          await message.edit(payload);
          return;
        } catch (error) {
          if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
        }
      }
    }
    const message = await channel.send(payload);
    await save(channel.id, message.id);
  }

  async restore(): Promise<void> {
    const pending = this.pendingMessageRemovals.splice(0);
    await this.removeMessages(pending);
    const sessions = await this.db.session.findMany({
      where: {
        deletedAt: null,
        OR: [{ state: { not: "ENDED" } }, { discordMessage: { isNot: null } }, { announcement: { isNot: null } }],
      },
      select: { id: true },
    });
    await this.refreshMany(sessions.map(({ id }) => id));
  }
}

type SessionRecord = {
  id: string;
  identityId: string;
  state: SessionState;
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
  deletedAt: Date | null;
  rankName: string;
  placeId: bigint;
  jobId: string;
  identity: { robloxUserId: bigint; robloxUsername: string; discordUserId: string | null };
  discordMessage: { channelId: string; messageId: string } | null;
  announcement: { channelId: string; messageId: string } | null;
};
