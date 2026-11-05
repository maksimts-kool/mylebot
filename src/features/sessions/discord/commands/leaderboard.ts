import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { Config } from "../../../../core/config.js";
import { BRAND_COLOR } from "../../../../shared/discord/colors.js";
import type { InteractionOutcome } from "../../../../shared/discord/interaction-log.js";
import { buildLeaderboard, tallinnDateRange } from "../../domain/reporting.js";
import type { SessionCommandContext } from "./context.js";
import { friendlyDuration, friendlyPeriod } from "./format.js";

const PAGE_SIZE = 10;

/**
 * The date range of a leaderboard period. A period never starts before the
 * first recorded session, so "this year" does not claim months nobody tracked.
 */
export function presetDates(
  config: Config,
  period: string,
  firstRecorded: Date | null,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const today = DateTime.fromJSDate(now).setZone(config.REPORT_TIMEZONE);
  const unit = period === "week" || period === "year" ? period : "month";
  let start = today.startOf(unit);
  const end = today.endOf(unit);
  if (firstRecorded) {
    const first = DateTime.fromJSDate(firstRecorded).setZone(config.REPORT_TIMEZONE).startOf("day");
    if (first > start && first <= end) start = first;
  }
  return { startDate: start.toISODate()!, endDate: end.toISODate()! };
}

/** When the oldest session still on record started, or null before the first one. */
export async function firstRecordedSession(ctx: SessionCommandContext): Promise<Date | null> {
  const first = await ctx.db.session.findFirst({
    where: { deletedAt: null }, orderBy: { startedAt: "asc" }, select: { startedAt: true },
  });
  return first?.startedAt ?? null;
}

export function leaderboardComponents(
  pageRows: Array<{ identityId: string; username: string }>,
  rowCount: number,
  startDate: string,
  endDate: string,
  minimum: number,
  page: number,
  disabled = false,
): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
  const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
  if (pageRows.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("leaderboard-user")
      .setPlaceholder("👤 View a user's session history")
      .addOptions(pageRows.map((row) => ({ label: row.username.split(" · ")[0]!.slice(0, 100), value: row.identityId })))
      .setDisabled(disabled),
  ));
  const refresh = new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Primary).setDisabled(disabled);
  // Paging only appears once there is a second page to go to.
  const buttons = rowCount > PAGE_SIZE
    ? [
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page-1}`).setLabel("Previous").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
      refresh,
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page+1}`).setLabel("Next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(disabled || (page+1)*PAGE_SIZE >= rowCount),
    ]
    : [refresh];
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  return components;
}

export async function renderLeaderboard(
  ctx: SessionCommandContext,
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  startDate: string,
  endDate: string,
  minimum: number,
  page: number,
): Promise<InteractionOutcome> {
  const { start, end } = tallinnDateRange(startDate, endDate, ctx.config.REPORT_TIMEZONE);
  const identities = await ctx.db.identity.findMany({ include: { sessions: { where: { deletedAt: null, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] }, include: { segments: true } } } });
  const rows = buildLeaderboard(identities.map((identity) => ({
    identityId: identity.id,
    username: identity.discordUserId ? `${identity.robloxUsername} · <@${identity.discordUserId}>` : identity.robloxUsername,
    sessions: identity.sessions,
  })), start, end, minimum);
  const pageRows = rows.slice(page*PAGE_SIZE, page*PAGE_SIZE+PAGE_SIZE);
  const period = friendlyPeriod(startDate, endDate, ctx.config.REPORT_TIMEZONE);
  const ranking = pageRows.map((row, index) => {
    const place = page * PAGE_SIZE + index + 1;
    const marker = (["🥇", "🥈", "🥉"] as const)[place - 1] ?? `**${place}.**`;
    return `${marker} **${row.username}**\n⏱️ ${friendlyDuration(row.totals.totalMs)} total · ${friendlyDuration(row.totals.activeMs)} active`;
  }).join("\n\n");
  const description = ranking
    ? `🗓️ **Period:** ${period}\n\n${ranking}`
    : `🗓️ **Period:** ${period}\n\n👥 No one has logged any time yet.`;
  const components = leaderboardComponents(pageRows, rows.length, startDate, endDate, minimum, page);
  const expiredComponents = leaderboardComponents(pageRows, rows.length, startDate, endDate, minimum, page, true);
  const response = {
    embeds: [new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle("🏆 Staff leaderboard")
      .setDescription(description)
      .setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(rows.length/PAGE_SIZE))} · Total time includes inactive time` })],
    components,
  };
  if (interaction.isButton()) {
    await interaction.update(response);
    ctx.publicComponents.track(interaction.message.id, interaction.user.id, async () => {
      await interaction.message.edit({ components: expiredComponents });
    });
  } else {
    const message = interaction.deferred || interaction.replied
      ? await interaction.editReply(response)
      : await interaction.reply(response);
    ctx.publicComponents.track(message.id, interaction.user.id, async () => {
      await message.edit({ components: expiredComponents });
    });
  }
  return {
    did: `${interaction.isButton() ? "showed" : "sent"} page ${page + 1} of the leaderboard for ${period}`,
    fields: { ranked: rows.length },
  };
}
