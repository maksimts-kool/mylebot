import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  MessageFlags, SlashCommandBuilder,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction, type Client, type Interaction,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { PermissionLevel, hasPermission } from "../../../shared/permissions.js";
import { KNOWN_FORUM_TAGS } from "../domain/mapping.js";
import type { TaigaSettingsService } from "../service/settings.js";
import type { TaigaSyncService } from "../service/taiga-sync.js";

export const taigaCommandData = [
  new SlashCommandBuilder().setName("taiga").setDescription("Open the Taiga board integration panel"),
].map((command) => command.toJSON());

const CUSTOM_IDS = {
  bugForum: "taiga-bug-forum",
  suggestionForum: "taiga-suggestion-forum",
  notifications: "taiga-notify-channel",
  toggle: "taiga-toggle:",
  reconcile: "taiga-reconcile",
  close: "taiga-close",
} as const;

function ownsCustomId(customId: string): boolean {
  return customId.startsWith("taiga-");
}

export class TaigaCommandHandler {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: TaigaSettingsService,
    private readonly sync: TaigaSyncService,
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The request could not be completed. Please try again later.";
      if (!(error instanceof UserFacingError)) console.error("Taiga interaction failed", { errorType: errorType(error) });
      if (!interaction.isRepliable()) return;
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
        else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        console.error("Failed to deliver Taiga interaction error", { errorType: errorType(replyError) });
      }
    }));
  }

  private owns(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand()) return interaction.commandName === "taiga";
    if (interaction.isMessageComponent()) return ownsCustomId(interaction.customId);
    return false;
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (!this.owns(interaction)) return;
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    if (!await hasPermission(this.db, interaction, PermissionLevel.MANAGER)) userError("Manager role required");

    // Rendering the panel checks the board over the network, which can outlast
    // Discord's three-second acknowledgement window. Acknowledge first, always.
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await this.panel());
      return;
    }
    if (interaction.isChannelSelectMenu()) { await this.handleChannelSelect(interaction); return; }
    if (interaction.isButton()) await this.handleButton(interaction);
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    const channel = interaction.channels.first();
    if (!channel) userError("Choose a channel");
    await interaction.deferUpdate();
    if (interaction.customId === CUSTOM_IDS.notifications) {
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) userError("Choose a text channel for notifications");
      await this.settings.setChannel("notificationChannelId", channel.id);
    } else {
      if (channel.type !== ChannelType.GuildForum) userError("Choose a forum channel");
      const field = interaction.customId === CUSTOM_IDS.bugForum ? "bugForumChannelId" : "suggestionForumChannelId";
      await this.settings.setChannel(field, channel.id);
    }
    await interaction.editReply(await this.panel());
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === CUSTOM_IDS.close) {
      await interaction.deferUpdate();
      await interaction.deleteReply(interaction.message.id);
      return;
    }
    if (interaction.customId.startsWith(CUSTOM_IDS.toggle)) {
      const enable = interaction.customId.endsWith(":on");
      if (enable) {
        const settings = await this.settings.get();
        if (!settings.bugForumChannelId || !settings.suggestionForumChannelId) userError("Choose both forums before enabling the integration");
        if (!this.config.TAIGA_USERNAME) userError("Taiga credentials are not configured in the environment");
      }
      await interaction.deferUpdate();
      await this.settings.setEnabled(enable);
      await interaction.editReply(await this.panel());
      return;
    }
    if (interaction.customId === CUSTOM_IDS.reconcile) {
      await interaction.deferUpdate();
      await this.sync.reconcile();
      await interaction.editReply(await this.panel());
    }
  }

  private async panel() {
    const settings = await this.settings.get();
    const health = await this.sync.health();
    const channel = (id: string) => (id ? `<#${id}>` : "Not configured");

    const notes: string[] = [...health.problems];
    if (health.missingColumns.length) notes.push(`Taiga board has no column named: ${health.missingColumns.join(", ")}`);
    if (health.missingTags.length) notes.push(`Forum tags missing: ${health.missingTags.join(", ")}`);
    if (!settings.notificationChannelId) notes.push("No notifications channel set — card updates will not be announced.");

    const embed = new EmbedBuilder()
      .setTitle("🗂️ Taiga board integration")
      .setDescription([
        "New forum posts become cards on the Taiga board, and moving a card retags its post.",
        `Forums need these tags: ${KNOWN_FORUM_TAGS.join(", ")}.`,
      ].join("\n"))
      .setColor(settings.enabled ? 0x22c55e : 0x6b7280)
      .addFields(
        { name: "Integration", value: settings.enabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
        { name: "Tracked cards", value: String(health.trackedCards), inline: true },
        { name: "Project", value: this.config.TAIGA_PROJECT_SLUG || "Not configured", inline: true },
        { name: "Bug reports forum", value: channel(settings.bugForumChannelId), inline: true },
        { name: "Suggestions forum", value: channel(settings.suggestionForumChannelId), inline: true },
        { name: "Notifications", value: channel(settings.notificationChannelId), inline: true },
        {
          name: "Posts tracked from",
          value: settings.activatedAt ? `<t:${Math.floor(settings.activatedAt.getTime() / 1000)}:f> — older posts are never touched` : "Not activated yet",
        },
        { name: "Health", value: notes.length ? notes.map((note) => `⚠️ ${note}`).join("\n") : "✅ No problems detected" },
      );

    const bugRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(CUSTOM_IDS.bugForum).setPlaceholder("Choose the bug reports forum").setChannelTypes(ChannelType.GuildForum),
    );
    const suggestionRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(CUSTOM_IDS.suggestionForum).setPlaceholder("Choose the suggestions forum").setChannelTypes(ChannelType.GuildForum),
    );
    const notifyRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(CUSTOM_IDS.notifications).setPlaceholder("Choose the notifications channel").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${CUSTOM_IDS.toggle}${settings.enabled ? "off" : "on"}`).setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setLabel(settings.enabled ? "Disable integration" : "Enable integration"),
      new ButtonBuilder().setCustomId(CUSTOM_IDS.reconcile).setStyle(ButtonStyle.Primary).setLabel("Reconcile now").setEmoji("🔄"),
      new ButtonBuilder().setCustomId(CUSTOM_IDS.close).setStyle(ButtonStyle.Secondary).setLabel("Close").setEmoji("✖️"),
    );
    return { embeds: [embed], components: [bugRow, suggestionRow, notifyRow, buttonRow] };
  }
}
