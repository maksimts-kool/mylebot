import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { userError } from "../../../core/errors.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import { configCustomId, type ConfigComponentInteraction, type ConfigSection, type ConfigView } from "../../../shared/discord/config-section.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";

const ID = "tracking";

/** Session tracking: the on/off switch and where session messages are posted. */
export function trackingSection(settings: RuntimeSettingsService): ConfigSection {
  async function view(): Promise<ConfigView> {
    const current = await settings.get();
    const embed = new EmbedBuilder()
      .setTitle("🎮 Session tracking")
      .setDescription("Roblox session tracking and the channel the bot publishes session messages to.")
      .setColor(BRAND_COLOR)
      .addFields(
        { name: "Tracking", value: current.trackingEnabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
        { name: "Logs channel", value: current.logsChannelId ? `<#${current.logsChannelId}>` : "Not configured", inline: true },
        {
          name: "What the switch does",
          value: "While tracking is disabled the bot ignores incoming Roblox events and stops sweeping live sessions. Nothing already recorded is deleted.",
          inline: false,
        },
      );
    const channelRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(configCustomId(ID, "logs"))
        .setPlaceholder("Choose the session logs channel")
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(configCustomId(ID, `toggle:${current.trackingEnabled ? "off" : "on"}`))
        .setStyle(current.trackingEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setLabel(current.trackingEnabled ? "Disable tracking" : "Enable tracking"),
    );
    return { embeds: [embed], components: [channelRow, buttonRow] };
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (action === "logs" && interaction.isChannelSelectMenu()) {
      const channel = interaction.channels.first();
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        userError("Choose a text channel for session logs");
      }
      await settings.setLogsChannel(channel.id);
      return null;
    }
    if (action.startsWith("toggle:")) {
      await settings.setTrackingEnabled(action.endsWith(":on"));
      return null;
    }
    return null;
  }

  return {
    id: ID,
    label: "Session tracking",
    emoji: "🎮",
    description: "Turn Roblox session tracking on or off and pick the logs channel.",
    view,
    apply,
  };
}
