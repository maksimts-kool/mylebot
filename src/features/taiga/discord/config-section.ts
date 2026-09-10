import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import { userError } from "../../../core/errors.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import { configCustomId, type ConfigComponentInteraction, type ConfigSection, type ConfigView } from "../../../shared/discord/config-section.js";
import { KNOWN_FORUM_TAGS } from "../domain/mapping.js";
import type { TaigaSettingsService } from "../service/settings.js";
import type { TaigaSyncService } from "../service/taiga-sync.js";

const ID = "taiga";

const ACTIONS = {
  bugForum: "bug-forum",
  suggestionForum: "suggestion-forum",
  notifications: "notify-channel",
  toggle: "toggle:",
  reconcile: "reconcile",
} as const;

/**
 * The Taiga board integration's page in `/config`: the two forums, the
 * notifications channel, the on/off switch, a health check, and a manual
 * reconcile. The feature only builds this when Taiga is configured, so the page
 * never appears on a deployment that cannot use it.
 */
export function taigaConfigSection(
  config: Config,
  settings: TaigaSettingsService,
  sync: TaigaSyncService,
): ConfigSection {
  async function view(): Promise<ConfigView> {
    const current = await settings.get();
    const health = await sync.health();
    const channel = (id: string) => (id ? `<#${id}>` : "Not configured");

    const notes: string[] = [...health.problems];
    if (health.missingColumns.length) notes.push(`Taiga board has no column named: ${health.missingColumns.join(", ")}`);
    if (health.missingTags.length) notes.push(`Forum tags missing: ${health.missingTags.join(", ")}`);
    if (!current.notificationChannelId) notes.push("No notifications channel set — card updates will not be announced.");

    const embed = new EmbedBuilder()
      .setTitle("🗂️ Taiga board integration")
      .setDescription([
        "New forum posts become cards on the Taiga board, and moving a card retags its post.",
        `Forums need these tags: ${KNOWN_FORUM_TAGS.join(", ")}.`,
      ].join("\n"))
      .setColor(BRAND_COLOR)
      .addFields(
        { name: "Integration", value: current.enabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
        { name: "Tracked cards", value: String(health.trackedCards), inline: true },
        { name: "Project", value: config.TAIGA_PROJECT_SLUG || "Not configured", inline: true },
        { name: "Bug reports forum", value: channel(current.bugForumChannelId), inline: true },
        { name: "Suggestions forum", value: channel(current.suggestionForumChannelId), inline: true },
        { name: "Notifications", value: channel(current.notificationChannelId), inline: true },
        {
          name: "Posts tracked from",
          value: current.activatedAt ? `<t:${Math.floor(current.activatedAt.getTime() / 1000)}:f> — older posts are never touched` : "Not activated yet",
        },
        { name: "Health", value: notes.length ? notes.map((note) => `⚠️ ${note}`).join("\n") : "✅ No problems detected" },
      );

    const bugRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(configCustomId(ID, ACTIONS.bugForum)).setPlaceholder("Choose the bug reports forum").setChannelTypes(ChannelType.GuildForum),
    );
    const suggestionRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(configCustomId(ID, ACTIONS.suggestionForum)).setPlaceholder("Choose the suggestions forum").setChannelTypes(ChannelType.GuildForum),
    );
    const notifyRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(configCustomId(ID, ACTIONS.notifications)).setPlaceholder("Choose the notifications channel").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(configCustomId(ID, `${ACTIONS.toggle}${current.enabled ? "off" : "on"}`))
        .setStyle(current.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setLabel(current.enabled ? "Disable integration" : "Enable integration"),
      new ButtonBuilder().setCustomId(configCustomId(ID, ACTIONS.reconcile)).setStyle(ButtonStyle.Primary).setLabel("Reconcile now").setEmoji("🔄"),
    );
    return { embeds: [embed], components: [bugRow, suggestionRow, notifyRow, buttonRow] };
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (interaction.isChannelSelectMenu()) {
      const channel = interaction.channels.first();
      if (!channel) userError("Choose a channel");
      if (action === ACTIONS.notifications) {
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) userError("Choose a text channel for notifications");
        await settings.setChannel("notificationChannelId", channel.id);
        return null;
      }
      if (channel.type !== ChannelType.GuildForum) userError("Choose a forum channel");
      await settings.setChannel(action === ACTIONS.bugForum ? "bugForumChannelId" : "suggestionForumChannelId", channel.id);
      return null;
    }
    if (action.startsWith(ACTIONS.toggle)) {
      const enable = action.endsWith(":on");
      if (enable) {
        const current = await settings.get();
        if (!current.bugForumChannelId || !current.suggestionForumChannelId) userError("Choose both forums before enabling the integration");
        if (!config.TAIGA_USERNAME) userError("Taiga credentials are not configured in the environment");
      }
      await settings.setEnabled(enable);
      return null;
    }
    if (action === ACTIONS.reconcile) {
      await sync.reconcile();
      return null;
    }
    return null;
  }

  return {
    id: ID,
    label: "Taiga board",
    emoji: "🗂️",
    description: "Forums, notifications channel, and the board sync switch.",
    view,
    apply,
  };
}
