import { ChannelType, EmbedBuilder, type Client, type SendableChannels } from "discord.js";
import type { TaigaCard, TaigaCardKind } from "@prisma/client";
import { errorType } from "../../../core/errors.js";
import type { TaigaClient } from "../client.js";
import { TaigaColumn, sameName } from "../domain/mapping.js";
import { discordThreadUrl } from "../domain/story.js";
import type { TaigaSettingsService } from "../service/settings.js";

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

/** Posts the card lifecycle to the notifications channel. Never throws into the sync path. */
export class TaigaNotifier {
  constructor(
    private readonly client: Client,
    private readonly settings: TaigaSettingsService,
    private readonly taiga: TaigaClient,
  ) {}

  private async channel(): Promise<SendableChannels | null> {
    const { notificationChannelId } = await this.settings.get();
    if (!notificationChannelId) return null;
    const channel = await this.client.channels.fetch(notificationChannelId).catch(() => null);
    if (!channel || channel.type === ChannelType.GuildForum || !channel.isSendable()) return null;
    return channel;
  }

  private async send(embed: EmbedBuilder): Promise<void> {
    try {
      const channel = await this.channel();
      if (!channel) return;
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.warn("Taiga notification failed", { errorType: errorType(error) });
    }
  }

  private links(card: TaigaCard): string {
    return `[Forum post](${discordThreadUrl(card.guildId, card.threadId)}) · [Taiga card #${card.taigaRef}](${this.taiga.storyUrl(card.taigaRef)})`;
  }

  async cardCreated(card: TaigaCard): Promise<void> {
    await this.send(new EmbedBuilder()
      .setTitle(`🆕 ${kindLabel(card.kind)} added to the board`)
      .setDescription(`**${card.title}**\n${this.links(card)}`)
      .setColor(columnColor(card.statusName))
      .addFields(
        { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
        { name: "Column", value: card.statusName, inline: true },
      ));
  }

  async cardMoved(card: TaigaCard, from: string, to: string): Promise<void> {
    await this.send(new EmbedBuilder()
      .setTitle(`📦 ${kindLabel(card.kind)} moved to ${to}`)
      .setDescription(`**${card.title}**\n${this.links(card)}`)
      .setColor(columnColor(to))
      .addFields(
        { name: "From", value: from, inline: true },
        { name: "To", value: to, inline: true },
        { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
      ));
  }

  async cardDeclined(card: TaigaCard): Promise<void> {
    await this.send(new EmbedBuilder()
      .setTitle(`🚫 ${kindLabel(card.kind)} declined`)
      .setDescription(`**${card.title}**\n[Forum post](${discordThreadUrl(card.guildId, card.threadId)})`)
      .setColor(DECLINED_COLOR)
      .addFields(
        { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
        { name: "Last column", value: card.statusName, inline: true },
      ));
  }

  async postRemoved(card: TaigaCard): Promise<void> {
    await this.send(new EmbedBuilder()
      .setTitle(`🗑️ ${kindLabel(card.kind)} post deleted`)
      .setDescription(`**${card.title}**\nThe forum post was deleted, so its Taiga card was removed too.`)
      .setColor(REMOVED_COLOR)
      .addFields(
        { name: "Author", value: `<@${card.authorDiscordId}>`, inline: true },
        { name: "Last column", value: card.statusName, inline: true },
      ));
  }

  async shippedCardRemoved(card: TaigaCard): Promise<void> {
    await this.send(new EmbedBuilder()
      .setTitle(`🧹 Shipped ${kindLabel(card.kind).toLowerCase()} cleared from the board`)
      .setDescription(`**${card.title}**\nThe card was deleted from *${TaigaColumn.IN_GAME}*, so the post keeps its Approved tag.`)
      .setColor(REMOVED_COLOR));
  }

  async epicEvent(
    epic: { id: number; ref: number; subject: string; statusName: string | null; isClosed: boolean },
    action: "created" | "updated" | "closed",
    relatedCards: TaigaCard[] = [],
  ): Promise<void> {
    const title = action === "created" ? "📘 New version epic" : action === "closed" ? "🚀 Version epic completed" : "📘 Version epic updated";
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**${epic.subject}**\n[Taiga epic #${epic.ref}](${this.taiga.epicUrl(epic.ref)})`)
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
    await this.send(embed);
  }
}
