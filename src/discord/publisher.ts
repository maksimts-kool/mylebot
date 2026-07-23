import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, DiscordAPIError, EmbedBuilder, type TextChannel,
} from "discord.js";
import type { SessionState } from "@prisma/client";
import type { Config } from "../config.js";
import type { prisma as database } from "../db.js";
import { totalsForPeriod } from "../domain/accounting.js";
import { calendarYearRange } from "../domain/reporting.js";
import type { BloxlinkService } from "../services/bloxlink.js";
import type { RuntimeSettingsService } from "../services/runtime-settings.js";
import type { DiscordMessageReference } from "../services/session-service.js";

type Db = typeof database;
const statusName: Record<SessionState, string> = { ACTIVE: "Active", INACTIVE: "Inactive", RECONNECTING: "Reconnecting", ENDED: "Ended" };
const statusColor: Record<SessionState, number> = { ACTIVE: 0x22c55e, INACTIVE: 0xf59e0b, RECONNECTING: 0x3b82f6, ENDED: 0x6b7280 };
const statusIcon: Record<SessionState, string> = { ACTIVE: "🟢", INACTIVE: "🟡", RECONNECTING: "🔵", ENDED: "⚫" };

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
    const discordUserId = session.identity.discordUserId ?? await this.bloxlink.discordForRoblox(session.identity.robloxUserId);
    const now = session.endedAt ?? new Date();
    const totals = totalsForPeriod(session.segments, session.startedAt, now, now);
    const username = discordUserId
      ? `${session.identity.robloxUsername} (<@${discordUserId}>)`
      : session.identity.robloxUsername;
    const fields = [
      { name: "Information", value: "\u200b", inline: false },
      { name: `${statusIcon[session.state]} Status`, value: statusName[session.state], inline: true },
      { name: "👤 Username", value: username, inline: true },
      { name: "📎 Rank", value: session.rankName, inline: true },
      { name: "Activity", value: "\u200b", inline: false },
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
      const yearMs = yearSessions.reduce((sum, item) => sum + totalsForPeriod(item.segments, year.start, year.end, now).totalMs, 0);
      const previous = await this.db.session.findFirst({
        where: { identityId: session.identityId, id: { not: session.id }, deletedAt: null, endedAt: { lt: session.startedAt } },
        orderBy: { endedAt: "desc" },
      });
      fields.push(
        { name: "History", value: "\u200b", inline: false },
        { name: `Total time (${reportYear})`, value: formatClock(yearMs), inline: true },
        { name: "Last time played", value: previous?.endedAt ? `<t:${Math.floor(previous.endedAt.getTime() / 1000)}:f>` : "No previous session", inline: true },
      );
    }
    const embed = new EmbedBuilder()
      .setTitle(`${session.deletedAt ? "Removed staff session" : "Staff session"} · ${session.id}`)
      .setDescription(`Started: <t:${Math.floor(session.startedAt.getTime() / 1000)}:f> | Updated: <t:${Math.floor(session.lastEventAt.getTime() / 1000)}:R>`)
      .setColor(statusColor[session.state])
      .addFields(fields);
    const buttons = buildSessionActionRow(session);
    const channel = await this.client.channels.fetch(settings.logsChannelId) as TextChannel;
    if (session.discordMessage) {
      if (session.discordMessage.channelId !== channel.id) {
        await this.removeMessages([{ channelId: session.discordMessage.channelId, messageId: session.discordMessage.messageId }]);
        const replacement = await channel.send({ embeds: [embed], components: session.deletedAt ? [] : [buttons] });
        await this.db.discordMessage.update({ where: { sessionId: session.id }, data: { channelId: channel.id, messageId: replacement.id } });
        return;
      }
      try {
        const message = await channel.messages.fetch(session.discordMessage.messageId);
        await message.edit({ embeds: [embed], components: session.deletedAt ? [] : [buttons] });
      } catch (error) {
        if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
        const replacement = await channel.send({ embeds: [embed], components: session.deletedAt ? [] : [buttons] });
        await this.db.discordMessage.update({ where: { sessionId: session.id }, data: { channelId: channel.id, messageId: replacement.id } });
      }
    } else {
      const message = await channel.send({ embeds: [embed], components: session.deletedAt ? [] : [buttons] });
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
