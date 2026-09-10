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
import { MINIMUM_SESSION_MILLISECONDS, sessionMeetsMinimum } from "../domain/policy.js";
import type { DiscordMessageReference } from "../service/session-service.js";
import { statusColor, statusIcon, statusName } from "./session-embed.js";

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
  const live = session.state !== "ENDED";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    // The announcement itself stays short; everything `/session active` would
    // show sits behind this button so the channel does not fill up with stats.
    new ButtonBuilder().setCustomId(`details:${session.id}`).setStyle(ButtonStyle.Primary).setLabel("More info"),
    ...(live ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Join Server").setURL(`https://www.roblox.com/games/start?placeId=${session.placeId}&gameInstanceId=${encodeURIComponent(session.jobId)}`)] : []),
    new ButtonBuilder().setCustomId(`history:${session.identityId}`).setStyle(ButtonStyle.Secondary).setLabel("View History"),
    ...(live ? [new ButtonBuilder().setCustomId(`refresh:${session.id}`).setStyle(ButtonStyle.Secondary).setLabel("Refresh")] : []),
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

  async removeMessages(messages: DiscordMessageReference[]): Promise<void> {
    if (!messages.length) return;
    if (!this.client.isReady()) {
      this.pendingMessageRemovals.push(...messages);
      return;
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
  }

  async refresh(sessionId: string, includeDeleted = false): Promise<void> {
    const settings = await this.settings.get();
    if (!this.client.isReady() || !settings.logsChannelId) return;
    const session = await this.db.session.findUnique({
      where: { id: sessionId }, include: { identity: true, segments: true, discordMessage: true },
    });
    if (!session || (session.deletedAt && !includeDeleted)) return;
    const now = session.endedAt ?? new Date();
    const totals = totalsForPeriod(session.segments, session.startedAt, now, now);
    if (session.state === "ENDED" && totals.totalMs < MINIMUM_SESSION_MILLISECONDS) {
      if (session.discordMessage) {
        await this.removeMessages([session.discordMessage]);
        await this.db.discordMessage.deleteMany({ where: { sessionId: session.id } });
      }
      return;
    }
    const discordUserId = session.identity.discordUserId ?? await this.bloxlink.discordForRoblox(session.identity.robloxUserId);
    const ended = session.state === "ENDED";
    // The mention lives in the message content, outside the embed, so the
    // member is actually pinged when their shift is announced.
    const content = discordUserId ? `<@${discordUserId}>` : session.identity.robloxUsername;
    const fields = [
      { name: `${statusIcon(session.state)} Status`, value: statusName(session.state), inline: true },
      { name: "👤 Username", value: session.identity.robloxUsername, inline: true },
      { name: "📎 Rank", value: session.rankName, inline: true },
    ];
    if (ended) {
      fields.push(
        { name: "Activity", value: "\u200b", inline: false },
        { name: "Total time", value: formatClock(totals.totalMs), inline: true },
        { name: "Active time", value: formatClock(totals.activeMs), inline: true },
        { name: "Inactive time", value: formatClock(totals.inactiveMs), inline: true },
      );
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
        { name: "History", value: "\u200b", inline: false },
        { name: `Total time (${reportYear})`, value: formatClock(yearMs), inline: true },
        { name: "Previous session", value: previous?.endedAt ? `<t:${Math.floor(previous.endedAt.getTime() / 1000)}:f>` : "No previous session", inline: true },
      );
    }
    const headline = session.deletedAt
      ? "🗑️ Session removed"
      : ended ? "✅ Session ended" : `${statusIcon(session.state)} Session started`;
    const timeline = ended && session.endedAt
      ? `Started <t:${Math.floor(session.startedAt.getTime() / 1000)}:f> · Ended <t:${Math.floor(session.endedAt.getTime() / 1000)}:R>`
      : `Started <t:${Math.floor(session.startedAt.getTime() / 1000)}:f> · Updated <t:${Math.floor(session.lastEventAt.getTime() / 1000)}:R>`;
    const embed = new EmbedBuilder()
      .setTitle(headline)
      .setDescription(timeline)
      .setColor(statusColor(session.state))
      .addFields(fields)
      .setFooter({ text: `Session ${session.id}` });
    const buttons = buildSessionActionRow(session);
    const channel = await this.client.channels.fetch(settings.logsChannelId) as TextChannel;
    if (session.discordMessage) {
      if (session.discordMessage.channelId !== channel.id) {
        await this.removeMessages([{ channelId: session.discordMessage.channelId, messageId: session.discordMessage.messageId }]);
        const replacement = await channel.send({ content, embeds: [embed], components: session.deletedAt ? [] : [buttons] });
        await this.db.discordMessage.update({ where: { sessionId: session.id }, data: { channelId: channel.id, messageId: replacement.id } });
        return;
      }
      try {
        const message = await channel.messages.fetch(session.discordMessage.messageId);
        await message.edit({ content, embeds: [embed], components: session.deletedAt ? [] : [buttons] });
      } catch (error) {
        if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
        const replacement = await channel.send({ content, embeds: [embed], components: session.deletedAt ? [] : [buttons] });
        await this.db.discordMessage.update({ where: { sessionId: session.id }, data: { channelId: channel.id, messageId: replacement.id } });
      }
    } else {
      const message = await channel.send({ content, embeds: [embed], components: session.deletedAt ? [] : [buttons] });
      await this.db.discordMessage.create({ data: { sessionId: session.id, channelId: channel.id, messageId: message.id } });
    }
  }

  async restore(): Promise<void> {
    const pending = this.pendingMessageRemovals.splice(0);
    await this.removeMessages(pending);
    const sessions = await this.db.session.findMany({
      where: { deletedAt: null, OR: [{ state: { not: "ENDED" } }, { discordMessage: { isNot: null } }] },
      select: { id: true },
    });
    await this.refreshMany(sessions.map(({ id }) => id));
  }
}
