import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import { configCustomId, type ConfigSection, type ConfigView } from "../../../shared/discord/config-section.js";
import type { VerificationService } from "../service/verification-service.js";

const ID = "verification";

/**
 * The verification timeout page in `/config`. The channel and role come from
 * the environment, so this page reports what is configured and how the current
 * cycle stands; `/verification status` is the per-member drill-down.
 */
export function verificationConfigSection(config: Config, service: VerificationService): ConfigSection {
  async function view(): Promise<ConfigView> {
    const status = await service.status();
    const now = new Date();
    const warned = status.members.filter((member) => member.warnedAt !== null).length;
    const dueNow = status.members.filter((member) => member.warnedAt !== null
      && member.removalDueAt !== null
      && member.removalDueAt.getTime() <= now.getTime()).length;
    const embed = new EmbedBuilder()
      .setTitle("🔐 Verification timeouts")
      .setDescription([
        "Members holding the Unverified role get a reminder every three days, a final warning on day 27, and are removed three days after that warning was delivered.",
        "The channel and role are environment settings, so they cannot be changed from here.",
      ].join("\n"))
      .setColor(BRAND_COLOR)
      .addFields(
        { name: "Reminder channel", value: config.VERIFICATION_CHANNEL_ID ? `<#${config.VERIFICATION_CHANNEL_ID}>` : "Not configured", inline: true },
        { name: "Unverified role", value: config.VERIFICATION_UNVERIFIED_ROLE_ID ? `<@&${config.VERIFICATION_UNVERIFIED_ROLE_ID}>` : "Not configured", inline: true },
        { name: "👥 Unverified", value: `**${status.members.length}**`, inline: true },
        { name: "⚠️ Warnings sent", value: `**${warned}**`, inline: true },
        { name: "🚨 Removal due", value: `**${dueNow}**`, inline: true },
        {
          name: "📨 Role reminder",
          value: status.lastReminderAt === null
            ? "❌ No successful reminder recorded yet"
            : `✅ Last sent <t:${Math.floor(status.lastReminderAt.getTime() / 1000)}:R>${status.nextReminderAt ? ` · ⏰ next <t:${Math.floor(status.nextReminderAt.getTime() / 1000)}:R>` : ""}`,
          inline: false,
        },
        { name: "Per-member detail", value: "Run `/verification status` for every member's warning and removal deadline.", inline: false },
      );
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(configCustomId(ID, "refresh")).setStyle(ButtonStyle.Primary).setLabel("Refresh").setEmoji("🔄"),
    );
    return { embeds: [embed], components: [row] };
  }

  return {
    id: ID,
    label: "Verification",
    emoji: "🔐",
    description: "Unverified reminder and removal cycle, and who it currently covers.",
    view,
    // Refreshing is just a re-render, so there is nothing to apply.
    apply: async () => null,
  };
}
