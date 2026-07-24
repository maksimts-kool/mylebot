import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { userError } from "../../../../core/errors.js";
import { totalsForPeriod } from "../../domain/accounting.js";
import type { SessionCommandContext } from "./context.js";
import { friendlyDuration } from "./format.js";

const PAGE_SIZE = 10;

export async function replyHistory(
  ctx: SessionCommandContext,
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  identityId: string,
  page: number,
  responseMode: "reply" | "update",
): Promise<void> {
  const count = await ctx.db.session.count({ where: { identityId, deletedAt: null } });
  const sessions = await ctx.db.session.findMany({ where: { identityId, deletedAt: null }, include: { identity: true, segments: true }, orderBy: { startedAt: "desc" }, skip: page * PAGE_SIZE, take: PAGE_SIZE });
  if (!sessions.length) userError("No sessions found");
  const identity = sessions[0]!.identity;
  const owner = identity.discordUserId ? `**${identity.robloxUsername}** · <@${identity.discordUserId}>` : `**${identity.robloxUsername}**`;
  const description = sessions.map((session) => {
    const end = session.endedAt ?? new Date();
    const totals = totalsForPeriod(session.segments, session.startedAt, end, end);
    const state = session.state === "ENDED" ? "Completed" : session.state === "ACTIVE" ? "Active now" : session.state === "INACTIVE" ? "Inactive now" : "Waiting for reconnect";
    const timing = session.endedAt
      ? `Started <t:${Math.floor(session.startedAt.getTime()/1000)}:f> and ended <t:${Math.floor(session.endedAt.getTime()/1000)}:R>`
      : `Started <t:${Math.floor(session.startedAt.getTime()/1000)}:R>`;
    const icon = session.state === "ENDED" ? "✅" : session.state === "ACTIVE" ? "🟢" : session.state === "INACTIVE" ? "🟡" : "🔵";
    return `${icon} **${state}**\n🗓️ ${timing}\n⏱️ ${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active · ${friendlyDuration(totals.inactiveMs)} inactive\n🆔 Session ID: \`${session.id}\``;
  }).join("\n\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`historypage:${identityId}:${page-1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`historypage:${identityId}:${page+1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled((page+1)*PAGE_SIZE >= count),
    new ButtonBuilder().setCustomId("historyclose").setLabel("Close").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
  );
  const response = {
    embeds: [new EmbedBuilder().setTitle("📚 Session history").setDescription(`👤 ${owner}\n\n${description}`).setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(count/PAGE_SIZE))}` })],
    components: [row],
  };
  if (responseMode === "update" && interaction.isButton()) await interaction.update(response);
  else if (interaction.deferred || interaction.replied) await interaction.editReply(response);
  else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
}
