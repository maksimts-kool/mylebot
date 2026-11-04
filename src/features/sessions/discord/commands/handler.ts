import {
  MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type Client,
  type Interaction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import type { Config } from "../../../../core/config.js";
import type { Db } from "../../../../core/db.js";
import { UserFacingError, errorType, userError } from "../../../../core/errors.js";
import { appLogger } from "../../../../core/logger.js";
import type { BloxlinkService } from "../../../../shared/bloxlink.js";
import { PublicComponentTracker } from "../../../../shared/discord/components.js";
import { PermissionLevel, hasPermission, permissionLabel } from "../../../../shared/permissions.js";
import type { RuntimeSettingsService } from "../../../../shared/runtime-settings.js";
import type { DiscordPublisher } from "../publisher.js";
import type { SessionCommandContext } from "./context.js";
import { requiredPermission, sessionCommandNames } from "./definitions.js";
import { HISTORY_IDS, parseAddCustomId, replyHistory, updateHistoryPage } from "./history.js";
import { firstRecordedSession, presetDates, renderLeaderboard } from "./leaderboard.js";
import {
  addSession, editEnded, removeSession, reopenSessionForm, showActive, showAddModal, showEditEndedModal, showManagePanel,
  showSessionDetails, showView,
} from "./session-commands.js";
import { SESSION_RETRY_PREFIX } from "./session-form.js";

/** Component identifiers this feature answers for. Everything else is another feature's. */
const EXACT_CUSTOM_IDS = new Set<string>(["leaderboard-user", HISTORY_IDS.manage]);
const CUSTOM_ID_PREFIXES = [
  "refresh:", "details:", "history:", HISTORY_IDS.page,
  "leaderboard:", "editended:", "remove:", HISTORY_IDS.add, SESSION_RETRY_PREFIX,
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
      if (!(error instanceof UserFacingError)) {
        appLogger().error({
          category: "command",
          actor: interaction.user.username,
          err: error,
          errorType: errorType(error),
          command: interaction.isCommand() ? interaction.commandName : undefined,
          customId: interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId : undefined,
        }, "Command failed");
      }
      if (interaction.isRepliable()) {
        // Delivering the error can itself fail (e.g. the interaction already
        // expired with a 10062). Swallow that so it never crashes the process.
        try {
          if (interaction.isChatInputCommand() && interaction.deferred && !interaction.replied && !interaction.ephemeral) {
            // A public command was already acknowledged in the channel. Errors
            // are the caller's alone, so take the placeholder down and say it privately.
            await interaction.deleteReply();
            await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
          } else if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
          else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
          else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        } catch (replyError) {
          appLogger().error({ category: "command", actor: interaction.user.username, err: replyError }, "Could not tell the user the command failed");
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
    else if (interaction.isStringSelectMenu()) await this.handleSelect(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(false);
    appLogger().info(
      { category: "command", actor: interaction.user.username },
      `/${interaction.commandName}${subcommand ? ` ${subcommand}` : ""}`,
    );
    if (interaction.commandName === "leaderboard") {
      await interaction.deferReply();
      const period = interaction.options.getString("period") ?? "month";
      const { startDate, endDate } = presetDates(this.config, period, await firstRecordedSession(this.ctx));
      await renderLeaderboard(this.ctx, interaction, startDate, endDate, 0, 0); return;
    }
    const action = interaction.options.getSubcommand();
    await this.ctx.requirePermission(interaction, requiredPermission(interaction.commandName, action));
    if (action === "view") await showView(this.ctx, interaction);
    if (action === "active") await showActive(this.ctx, interaction);
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const addFor = parseAddCustomId(interaction.customId);
    if (addFor) await addSession(this.ctx, interaction, addFor);
    else if (interaction.customId.startsWith("editended:")) await editEnded(this.ctx, interaction);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith("refresh:")) {
      await interaction.deferUpdate();
      await this.ctx.publisher.refresh(interaction.customId.slice(8));
      return;
    }
    if (interaction.customId.startsWith("details:")) {
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      await showSessionDetails(this.ctx, interaction, interaction.customId.slice("details:".length));
      return;
    }
    if (interaction.customId.startsWith("history:")) {
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      // The record lives in the logs channel; keep that channel free of replies.
      await replyHistory(this.ctx, interaction, { identityId: interaction.customId.slice(8) }, "private");
      return;
    }
    if (interaction.customId.startsWith(HISTORY_IDS.page)) {
      await this.requireOwnerIfPublic(interaction);
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      const [, identityId, page] = interaction.customId.split(":");
      await updateHistoryPage(this.ctx, interaction, identityId!, Number(page));
      return;
    }
    if (interaction.customId.startsWith(SESSION_RETRY_PREFIX)) {
      // Sits on a private error reply, and the answers it refills are the clicker's own.
      await reopenSessionForm(this.ctx, interaction, interaction.customId.slice(SESSION_RETRY_PREFIX.length));
      return;
    }
    const addFor = parseAddCustomId(interaction.customId);
    if (addFor) {
      await this.requireOwnerIfPublic(interaction);
      await showAddModal(this.ctx, interaction, addFor);
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

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === HISTORY_IDS.manage) {
      await this.requireOwnerIfPublic(interaction);
      await showManagePanel(this.ctx, interaction);
      return;
    }
    if (interaction.customId !== "leaderboard-user") return;
    await this.requirePublicComponentOwner(interaction);
    await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
    await replyHistory(this.ctx, interaction, { identityId: interaction.values[0]! }, "public");
  }

  /** Only the caller sees a private message, so only a public one needs the owner check. */
  private async requireOwnerIfPublic(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) return;
    await this.requirePublicComponentOwner(interaction);
  }

  private async requirePublicComponentOwner(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const access = this.publicComponents.access(interaction.message.id, interaction.user.id);
    if (access === "not-owner") userError("Only the person who ran this command can use these controls");
    if (access === "expired") {
      await interaction.message.edit({ components: [] }).catch((error: unknown) => {
        appLogger().error({ category: "command", err: error, messageId: interaction.message.id }, "Could not remove expired controls");
      });
      userError("These controls have expired. Run the command again");
    }
  }
}
