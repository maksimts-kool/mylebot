import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  type Client, type SendableChannels,
} from "discord.js";
import type { TaigaCardKind } from "@prisma/client";
import { errorType } from "../../../core/errors.js";
import { appLogger } from "../../../core/logger.js";
import { TaigaColumn, sameName } from "../domain/mapping.js";
import { discordThreadUrl } from "../domain/story.js";
import type { CardView, TaigaNotice } from "../link.js";

const COLUMN_COLOR: Record<string, number> = {
  [TaigaColumn.SUGGESTED]: 0x3b82f6,
  [TaigaColumn.PLANNED]: 0xa855f7,
  [TaigaColumn.IN_PROGRESS]: 0xf59e0b,
  [TaigaColumn.DONE]: 0x22c55e,
  [TaigaColumn.IN_GAME]: 0x16a34a,
};
const DECLINED_COLOR = 0xef4444;
const REMOVED_COLOR = 0x6b7280;
const EPIC_COLOR = 0x8b5cf6;

function columnColor(columnName: string): number {
  const match = Object.entries(COLUMN_COLOR).find(([name]) => sameName(name, columnName));
  return match?.[1] ?? 0x6b7280;
}

export function kindLabel(kind: TaigaCardKind): string {
  return kind === "BUG" ? "Bug report" : "Suggestion";
}

function forumButton(card: CardView): ButtonBuilder {
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("Forum post")
    .setEmoji("💬")
    .setURL(discordThreadUrl(card.guildId, card.threadId));
}

function cardButtons(card: CardView, storyUrl: string): ButtonBuilder[] {
  return [
    forumButton(card),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`Taiga card #${card.taigaRef}`)
      .setEmoji("📋")
      .setURL(storyUrl),
  ];
}

/** What one notice looks like in the notifications channel. */
export function renderNotice(notice: TaigaNotice): { embed: EmbedBuilder; buttons: ButtonBuilder[] } {
  if (notice.type === "epic") {
    const { epic, action, relatedCards } = notice;
    const title = action === "created" ? "📘 New version epic" : action === "closed" ? "🚀 Version epic completed" : "📘 Version epic updated";
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**${epic.subject}**`)
      .setColor(EPIC_COLOR);
    if (epic.statusName) embed.addFields({ name: "Status", value: epic.statusName, inline: true });
    if (relatedCards.length) {
      // Discord truncates hard at 1024 characters per field.
      const lines: string[] = [];
      let used = 0;
      for (const card of relatedCards) {
        const line = `• [${card.title}](${discordThreadUrl(card.guildId, card.threadId)})`;
        if (used + line.length + 1 > 1000) {
          lines.push(`…and ${relatedCards.length - lines.length} more`);
          break;
        }
        lines.push(line);
        used += line.length + 1;
      }
      embed.addFields({ name: `Included posts (${relatedCards.length})`, value: lines.join("\n") });
    }
    return {
      embed,
      buttons: [new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(`Taiga epic #${epic.ref}`)
        .setEmoji("📘")
        .setURL(notice.epicUrl)],
    };
  }

  const { card } = notice;
  switch (notice.type) {
    case "cardCreated":
      return {
        embed: new EmbedBuilder()
          .setTitle(`🆕 ${kindLabel(card.kind)} added to the board`)
          .setDescription(`**${card.title}**`)
          .setColor(columnColor(card.statusName))
          .addFields(
            { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
            { name: "Column", value: card.statusName, inline: true },
          ),
        buttons: cardButtons(card, notice.storyUrl),
      };
    case "cardMoved":
      return {
        embed: new EmbedBuilder()
          .setTitle(`📦 ${kindLabel(card.kind)} moved to ${notice.to}`)
          .setDescription(`**${card.title}**`)
          .setColor(columnColor(notice.to))
          .addFields(
            { name: "From", value: notice.from, inline: true },
            { name: "To", value: notice.to, inline: true },
            { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
          ),
        buttons: cardButtons(card, notice.storyUrl),
      };
    case "cardDeclined":
      return {
        embed: new EmbedBuilder()
          .setTitle(`🚫 ${kindLabel(card.kind)} declined`)
          .setDescription(`**${card.title}**`)
          .setColor(DECLINED_COLOR)
          .addFields(
            { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
            { name: "Last column", value: card.statusName, inline: true },
          ),
        buttons: [forumButton(card)],
      };
    case "postRemoved":
      return {
        embed: new EmbedBuilder()
          .setTitle(`🗑️ ${kindLabel(card.kind)} post deleted`)
          .setDescription(`**${card.title}**\nThe forum post was deleted, so its Taiga card was removed too.`)
          .setColor(REMOVED_COLOR)
          .addFields(
            { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
            { name: "Last column", value: card.statusName, inline: true },
          ),
        buttons: [],
      };
    case "shippedCardRemoved":
      return {
        embed: new EmbedBuilder()
          .setTitle(`🧹 Shipped ${kindLabel(card.kind).toLowerCase()} cleared from the board`)
          .setDescription(`**${card.title}**\nThe card was deleted from *${TaigaColumn.IN_GAME}*, so the post keeps its Approved tag.`)
          .setColor(REMOVED_COLOR),
        buttons: [],
      };
  }
}

/** Posts the card lifecycle to the notifications channel. Never throws into the sync path. */
export async function postNotice(client: Client, channelId: string, notice: TaigaNotice): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type === ChannelType.GuildForum || !channel.isSendable()) return;
    const { embed, buttons } = renderNotice(notice);
    const components = buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [];
    await (channel as SendableChannels).send({ embeds: [embed], components });
  } catch (error) {
    appLogger().warn({ category: "taiga", err: error, errorType: errorType(error) }, "Could not post to the notifications channel");
  }
}
