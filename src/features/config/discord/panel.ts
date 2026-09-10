import {
  ActionRowBuilder, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
  type Client, type Interaction, type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import type { ConfigComponentInteraction, ConfigRow, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import { PermissionLevel, hasPermission } from "../../../shared/permissions.js";
import {
  CONFIG_CLOSE_VALUE, CONFIG_CUSTOM_ID_PREFIX, CONFIG_HOME_VALUE, CONFIG_NAV_CUSTOM_ID,
} from "./definitions.js";

type PanelMessage = { embeds: EmbedBuilder[]; components: ConfigRow[] };

/**
 * `/config` is the single place every server setting lives. The panel owns the
 * command, the manager check, navigation, and acknowledging the interaction;
 * each feature only contributes a `ConfigSection` that renders itself.
 */
export class ConfigPanelHandler {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly sections: ConfigSection[],
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The configuration panel could not be updated. Please try again later.";
      if (!(error instanceof UserFacingError)) console.error("Configuration interaction failed", { errorType: errorType(error) });
      if (!interaction.isRepliable()) return;
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
        else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        console.error("Failed to deliver configuration interaction error", { errorType: errorType(replyError) });
      }
    }));
  }

  private owns(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand()) return interaction.commandName === "config";
    if (interaction.isMessageComponent()) return interaction.customId.startsWith(CONFIG_CUSTOM_ID_PREFIX);
    return false;
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (!this.owns(interaction)) return;
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    if (!await hasPermission(this.db, interaction, PermissionLevel.MANAGER)) userError("Manager role required");

    // Sections read Discord and the board over the network, which can outlast
    // the three-second acknowledgement window. Acknowledge first, always.
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await this.render(CONFIG_HOME_VALUE));
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === CONFIG_NAV_CUSTOM_ID) {
      const target = interaction.values[0] ?? CONFIG_HOME_VALUE;
      if (target === CONFIG_CLOSE_VALUE) {
        await interaction.deferUpdate();
        await interaction.deleteReply(interaction.message.id);
        return;
      }
      await interaction.deferUpdate();
      await interaction.editReply(await this.render(target));
      return;
    }
    if (interaction.isButton() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isStringSelectMenu()) {
      await this.applySection(interaction);
    }
  }

  private async applySection(interaction: ConfigComponentInteraction): Promise<void> {
    const [, sectionId, ...rest] = interaction.customId.split(":");
    const section = this.sections.find(({ id }) => id === sectionId);
    if (!section) userError("That configuration page is no longer available");
    await interaction.deferUpdate();
    const view = await section.apply(interaction, rest.join(":")) ?? await section.view();
    await interaction.editReply(this.compose(section.id, view));
  }

  private async render(sectionId: string): Promise<PanelMessage> {
    const section = this.sections.find(({ id }) => id === sectionId);
    if (!section) return this.compose(CONFIG_HOME_VALUE, { embeds: [this.homeEmbed()], components: [] });
    return this.compose(section.id, await section.view());
  }

  private compose(sectionId: string, view: ConfigView): PanelMessage {
    return { embeds: view.embeds, components: [...view.components, this.navigationRow(sectionId)] };
  }

  private homeEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle("⚙️ Server configuration")
      .setDescription("Every setting the bot keeps for this server lives here. Choose a page below. This panel is only visible to you.")
      .setColor(BRAND_COLOR)
      .addFields(this.sections.map((section) => ({
        name: `${section.emoji} ${section.label}`,
        value: section.description,
        inline: false,
      })));
  }

  /**
   * The panel's own row. Closing lives in the menu rather than in a button so
   * every section may use the four action rows Discord leaves over.
   */
  private navigationRow(sectionId: string): ConfigRow {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(CONFIG_NAV_CUSTOM_ID)
      .setPlaceholder("Go to a configuration page")
      .addOptions(
        { label: "Overview", value: CONFIG_HOME_VALUE, emoji: "⚙️", description: "Every page in one list", default: sectionId === CONFIG_HOME_VALUE },
        ...this.sections.map((section) => ({
          label: section.label,
          value: section.id,
          emoji: section.emoji,
          description: section.description.slice(0, 100),
          default: section.id === sectionId,
        })),
        { label: "Close panel", value: CONFIG_CLOSE_VALUE, emoji: "✖️", description: "Dismiss this panel" },
      );
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
  }
}
