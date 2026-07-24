import {
  MessageFlags,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction, type Client,
  type Interaction, type ModalSubmitInteraction, type RoleSelectMenuInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import type { Config } from "../../../../core/config.js";
import type { Db } from "../../../../core/db.js";
import { UserFacingError, userError } from "../../../../core/errors.js";
import type { BloxlinkService } from "../../../../shared/bloxlink.js";
import { PublicComponentTracker } from "../../../../shared/discord/components.js";
import { PermissionLevel, hasPermission, permissionLabel } from "../../../../shared/permissions.js";
import type { RuntimeSettingsService } from "../../../../shared/runtime-settings.js";
import type { DiscordPublisher } from "../publisher.js";
import { applyRoleLevel, configPanel, selectLogsChannel, selectPermissionRole, toggleTracking } from "./config-panel.js";
import type { SessionCommandContext } from "./context.js";
import { requiredPermission, sessionCommandNames } from "./definitions.js";
import { replyHistory } from "./history.js";
import { presetDates, renderLeaderboard } from "./leaderboard.js";
import {
  addSession, editEnded, removeSession, showActive, showAdd, showEditEndedModal, showManage, showView,
} from "./session-commands.js";

/** Component identifiers this feature answers for. Everything else is another feature's. */
const EXACT_CUSTOM_IDS = new Set(["cancel", "historyclose", "config-logs", "config-role", "leaderboard-user"]);
const CUSTOM_ID_PREFIXES = [
  "refresh:", "config-tracking:", "config-role-level:", "history:", "historypage:",
  "leaderboard:", "editended:", "remove:", "add:",
];

function ownsCustomId(customId: string): boolean {
  return EXACT_CUSTOM_IDS.has(customId) || CUSTOM_ID_PREFIXES.some((prefix) => customId.startsWith(prefix));
}

export class SessionCommandHandler {
  private readonly publicComponents = new PublicComponentTracker();
  private readonly ctx: SessionCommandContext;

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    publisher: DiscordPublisher,
    bloxlink: BloxlinkService,
    settings: RuntimeSettingsService,
  ) {
    this.ctx = {
      db, config, publisher, bloxlink, settings,
      publicComponents: this.publicComponents,
      hasPermission: (interaction, required) => hasPermission(db, interaction, required),
      requirePermission: async (interaction, required, message) => {
        if (!await hasPermission(db, interaction, required)) userError(message ?? `${permissionLabel(required)} role required`);
      },
      requirePublicComponentOwner: (interaction) => this.requirePublicComponentOwner(interaction),
    };
  }

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The request could not be completed. Please try again later.";
      if (!(error instanceof UserFacingError)) console.error("Discord interaction failed", {
        error,
        command: interaction.isCommand() ? interaction.commandName : undefined,
        customId: interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId : undefined,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      if (interaction.isRepliable()) {
        // Delivering the error can itself fail (e.g. the interaction already
        // expired with a 10062). Swallow that so it never crashes the process.
        try {
          if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
          else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
          else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        } catch (replyError) {
          console.error("Failed to deliver interaction error message", { replyError, userId: interaction.user.id });
        }
      }
    }));
  }

  /** Other features share this gateway event, so ignore anything not ours. */
  private owns(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand()) return sessionCommandNames.has(interaction.commandName);
    if (interaction.isModalSubmit() || interaction.isMessageComponent()) return ownsCustomId(interaction.customId);
    return false;
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (!this.owns(interaction)) return;
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    if (interaction.isChatInputCommand()) await this.handleCommand(interaction);
    else if (interaction.isModalSubmit()) await this.handleModal(interaction);
    else if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isChannelSelectMenu()) await this.handleChannelSelect(interaction);
    else if (interaction.isRoleSelectMenu()) await this.handleRoleSelect(interaction);
    else if (interaction.isStringSelectMenu()) await this.handleSelect(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "leaderboard") {
      await interaction.deferReply();
      const period = interaction.options.getString("period") ?? "month";
      const { startDate, endDate } = presetDates(this.config, period);
      await renderLeaderboard(this.ctx, interaction, startDate, endDate, 0, 0); return;
    }
    if (interaction.commandName === "config") {
      await this.ctx.requirePermission(interaction, PermissionLevel.MANAGER);
      await interaction.reply({ ...await configPanel(this.ctx), flags: MessageFlags.Ephemeral }); return;
    }
    const action = interaction.options.getSubcommand();
    await this.ctx.requirePermission(interaction, requiredPermission(interaction.commandName, action));
    if (action === "add") await showAdd(this.ctx, interaction);
    if (action === "manage") await showManage(this.ctx, interaction);
    if (action === "view") await showView(this.ctx, interaction);
    if (action === "active") await showActive(this.ctx, interaction);
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith("add:")) await addSession(this.ctx, interaction);
    else if (interaction.customId.startsWith("editended:")) await editEnded(this.ctx, interaction);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === "cancel" || interaction.customId === "historyclose") {
      await interaction.deferUpdate();
      await interaction.deleteReply(interaction.message.id);
      return;
    }
    if (interaction.customId.startsWith("refresh:")) {
      await interaction.deferUpdate();
      await this.ctx.publisher.refresh(interaction.customId.slice(8));
      return;
    }
    if (interaction.customId.startsWith("config-tracking:")) {
      await toggleTracking(this.ctx, interaction);
      return;
    }
    if (interaction.customId.startsWith("config-role-level:")) {
      await applyRoleLevel(this.ctx, interaction);
      return;
    }
    if (interaction.customId.startsWith("history:")) {
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      await replyHistory(this.ctx, interaction, interaction.customId.slice(8), 0, "reply");
      return;
    }
    if (interaction.customId.startsWith("historypage:")) {
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      const [, identityId, page] = interaction.customId.split(":");
      await replyHistory(this.ctx, interaction, identityId!, Number(page), "update");
      return;
    }
    if (interaction.customId.startsWith("leaderboard:")) {
      await this.requirePublicComponentOwner(interaction);
      const [, startDate, endDate, minimum, page] = interaction.customId.split(":");
      await renderLeaderboard(this.ctx, interaction, startDate!, endDate!, Number(minimum), Number(page)); return;
    }
    if (interaction.customId.startsWith("editended:")) {
      await showEditEndedModal(this.ctx, interaction, interaction.customId.slice("editended:".length)); return;
    }
    if (interaction.customId.startsWith("remove:")) {
      await removeSession(this.ctx, interaction, interaction.customId.slice(7));
    }
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config-logs") return;
    await selectLogsChannel(this.ctx, interaction);
  }

  private async handleRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config-role") return;
    await selectPermissionRole(this.ctx, interaction);
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "leaderboard-user") return;
    await this.requirePublicComponentOwner(interaction);
    await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
    await replyHistory(this.ctx, interaction, interaction.values[0]!, 0, "reply");
  }

  private async requirePublicComponentOwner(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const access = this.publicComponents.access(interaction.message.id, interaction.user.id);
    if (access === "not-owner") userError("Only the person who ran this command can use these controls");
    if (access === "expired") {
      await interaction.message.edit({ components: [] }).catch((error: unknown) => {
        console.error("Failed to remove expired public controls", { error, messageId: interaction.message.id });
      });
      userError("These controls have expired. Run the command again");
    }
  }
}
