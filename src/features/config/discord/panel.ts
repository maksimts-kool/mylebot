import {
  ActionRowBuilder, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
  type Client, type Interaction, type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { appLogger } from "../../../core/logger.js";
import { hasPermission, type AccessSource } from "../../../shared/discord/access.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import type { ConfigComponentInteraction, ConfigRow, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import { InteractionLog, type InteractionOutcome } from "../../../shared/discord/interaction-log.js";
import { PermissionLevel } from "../../../shared/permissions.js";
import {
  CONFIG_CLOSE_VALUE, CONFIG_CUSTOM_ID_PREFIX, CONFIG_HOME_VALUE, CONFIG_NAV_CUSTOM_ID,
} from "./definitions.js";

type PanelMessage = { embeds: EmbedBuilder[]; components: ConfigRow[] };

/** What a select menu was set to, by name, so a settings change can be read back from the log. */
function chosen(interaction: ConfigComponentInteraction): string | undefined {
  if (interaction.isChannelSelectMenu()) {
    return interaction.channels.map((channel) => ("name" in channel && channel.name ? `#${channel.name}` : channel.id)).join(", ");
  }
  if (interaction.isRoleSelectMenu()) return interaction.roles.map((role) => `@${role.name}`).join(", ");
  if (interaction.isStringSelectMenu()) return interaction.values.join(", ");
  return undefined;
}

/**
 * `/config` is the single place every server setting lives. The panel owns the
 * command, the manager check, navigation, and acknowledging the interaction;
 * each feature only contributes a `ConfigSection` that renders itself.
 */
export class ConfigPanelHandler {
  constructor(
    private readonly client: Client,
    private readonly access: AccessSource,
    private readonly config: Config,
    private readonly sections: ConfigSection[],
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => {
      if (!this.owns(interaction)) return;
      const trace = new InteractionLog(interaction, appLogger().child({ category: "config" }));
      void this.handle(interaction).then((outcome) => trace.done(outcome), async (error: unknown) => {
        trace.failed(error);
        const message = error instanceof UserFacingError ? error.message : "The configuration panel could not be updated. Please try again later.";
        if (!interaction.isRepliable()) return;
        try {
          if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
          else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
          else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        } catch (replyError) {
          appLogger().error({ category: "config", err: replyError, errorType: errorType(replyError) }, "Could not tell the user the panel failed");
        }
      });
    });
  }

  private owns(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand()) return interaction.commandName === "config";
    if (interaction.isMessageComponent()) return interaction.customId.startsWith(CONFIG_CUSTOM_ID_PREFIX);
    return false;
  }

  private async handle(interaction: Interaction): Promise<InteractionOutcome | void> {
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    if (!await hasPermission(this.access, interaction, PermissionLevel.MANAGER)) userError("Manager role required");

    // Sections read Discord and the board over the network, which can outlast
    // the three-second acknowledgement window. Acknowledge first, always.
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await this.render(CONFIG_HOME_VALUE));
      return { did: "opened the configuration panel" };
    }
    if (interaction.isStringSelectMenu() && interaction.customId === CONFIG_NAV_CUSTOM_ID) {
      const target = interaction.values[0] ?? CONFIG_HOME_VALUE;
      if (target === CONFIG_CLOSE_VALUE) {
        await interaction.deferUpdate();
        await interaction.deleteReply(interaction.message.id);
        return { did: "closed the configuration panel" };
      }
      await interaction.deferUpdate();
      await interaction.editReply(await this.render(target));
      const section = this.sections.find(({ id }) => id === target);
      return { did: `opened the ${section?.label ?? "Overview"} page` };
    }
    if (interaction.isButton() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isStringSelectMenu()) {
      return this.applySection(interaction);
    }
  }

  private async applySection(interaction: ConfigComponentInteraction): Promise<InteractionOutcome> {
    const [, sectionId, ...rest] = interaction.customId.split(":");
    const section = this.sections.find(({ id }) => id === sectionId);
    if (!section) userError("That configuration page is no longer available");
    await interaction.deferUpdate();
    const action = rest.join(":");
    const view = await section.apply(interaction, action) ?? await section.view();
    await interaction.editReply(this.compose(section.id, view));
    return { did: `applied ${action} on the ${section.label} page`, fields: { chose: chosen(interaction) } };
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
      .setDescription(this.sections.map((section) => `${section.emoji} ${section.label}`).join("\n"))
      .setColor(BRAND_COLOR);
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
        { label: "Overview", value: CONFIG_HOME_VALUE, emoji: "⚙️", default: sectionId === CONFIG_HOME_VALUE },
        ...this.sections.map((section) => ({
          label: section.label,
          value: section.id,
          emoji: section.emoji,
          default: section.id === sectionId,
        })),
        { label: "Close panel", value: CONFIG_CLOSE_VALUE, emoji: "✖️" },
      );
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
  }
}
