import {
  MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type Client,
  type Interaction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import type { Config } from "../../../../core/config.js";
import { UserFacingError, userError } from "../../../../core/errors.js";
import { appLogger } from "../../../../core/logger.js";
import { hasPermission, requirePermission } from "../../../../shared/discord/access.js";
import { PublicComponentTracker } from "../../../../shared/discord/components.js";
import { InteractionLog, type InteractionOutcome } from "../../../../shared/discord/interaction-log.js";
import { PermissionLevel } from "../../../../shared/permissions.js";
import type { SharedServerPort } from "../../../../shared/server-port.js";
import type { SessionsServerPort } from "../../link.js";
import type { SessionCommandContext } from "./context.js";
import { requiredPermission, sessionCommandNames } from "./definitions.js";
import { HISTORY_IDS, parseAddCustomId, replyHistory, updateHistoryPage } from "./history.js";
import { presetDates, renderLeaderboard } from "./leaderboard.js";
import { showBadgeGuide, showProfile } from "./profile.js";
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
    private readonly config: Config,
    sessions: SessionsServerPort,
    shared: SharedServerPort,
  ) {
    this.ctx = {
      config, sessions, shared,
      publicComponents: this.publicComponents,
      hasPermission: (interaction, required) => hasPermission(shared, interaction, required),
      requirePermission: (interaction, required, message) => requirePermission(shared, interaction, required, message),
      requirePublicComponentOwner: (interaction) => this.requirePublicComponentOwner(interaction),
    };
  }

  register(): void {
    this.client.on("interactionCreate", (interaction) => {
      if (!this.owns(interaction)) return;
      const trace = new InteractionLog(interaction, appLogger().child({ category: "command" }));
      void this.handle(interaction).then((outcome) => trace.done(outcome), (error: unknown) => {
        trace.failed(error);
        return this.reportError(interaction, error);
      });
    });
  }

  /** Tells the caller why nothing happened. Delivering that can fail too, and is only logged. */
  private async reportError(interaction: Interaction, error: unknown): Promise<void> {
    if (!interaction.isRepliable()) return;
    const message = error instanceof UserFacingError ? error.message : "The request could not be completed. Please try again later.";
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

  /** Other features share this gateway event, so ignore anything not ours. */
  private owns(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand()) return sessionCommandNames.has(interaction.commandName);
    if (interaction.isModalSubmit() || interaction.isMessageComponent()) return ownsCustomId(interaction.customId);
    return false;
  }

  private async handle(interaction: Interaction): Promise<InteractionOutcome | void> {
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    if (interaction.isChatInputCommand()) return this.handleCommand(interaction);
    if (interaction.isModalSubmit()) return this.handleModal(interaction);
    if (interaction.isButton()) return this.handleButton(interaction);
    if (interaction.isStringSelectMenu()) return this.handleSelect(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<InteractionOutcome | void> {
    if (interaction.commandName === "leaderboard") {
      await interaction.deferReply();
      const period = interaction.options.getString("period") ?? "month";
      const { startDate, endDate } = presetDates(this.config, period, await this.ctx.sessions.firstRecordedSession());
      return renderLeaderboard(this.ctx, interaction, startDate, endDate, 0, 0);
    }
    if (interaction.commandName === "profile") return showProfile(this.ctx, interaction);
    if (interaction.commandName === "badges") return showBadgeGuide(this.ctx, interaction);
    const action = interaction.options.getSubcommand();
    await this.ctx.requirePermission(interaction, requiredPermission(interaction.commandName, action));
    if (action === "view") return showView(this.ctx, interaction);
    if (action === "active") return showActive(this.ctx, interaction);
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<InteractionOutcome | void> {
    const addFor = parseAddCustomId(interaction.customId);
    if (addFor) return addSession(this.ctx, interaction, addFor);
    if (interaction.customId.startsWith("editended:")) return editEnded(this.ctx, interaction);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<InteractionOutcome | void> {
    if (interaction.customId.startsWith("refresh:")) {
      await interaction.deferUpdate();
      const sessionId = interaction.customId.slice(8);
      await this.ctx.sessions.refresh(sessionId);
      return { did: "refreshed the session message", fields: { sessionId } };
    }
    if (interaction.customId.startsWith("details:")) {
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      return showSessionDetails(this.ctx, interaction, interaction.customId.slice("details:".length));
    }
    if (interaction.customId.startsWith("history:")) {
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      // The record lives in the logs channel; keep that channel free of replies.
      return replyHistory(this.ctx, interaction, { identityId: interaction.customId.slice(8) }, "private");
    }
    if (interaction.customId.startsWith(HISTORY_IDS.page)) {
      await this.requireOwnerIfPublic(interaction);
      await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
      const [, identityId, page] = interaction.customId.split(":");
      return updateHistoryPage(this.ctx, interaction, identityId!, Number(page));
    }
    if (interaction.customId.startsWith(SESSION_RETRY_PREFIX)) {
      // Sits on a private error reply, and the answers it refills are the clicker's own.
      return reopenSessionForm(this.ctx, interaction, interaction.customId.slice(SESSION_RETRY_PREFIX.length));
    }
    const addFor = parseAddCustomId(interaction.customId);
    if (addFor) {
      await this.requireOwnerIfPublic(interaction);
      return showAddModal(this.ctx, interaction, addFor);
    }
    if (interaction.customId.startsWith("leaderboard:")) {
      await this.requirePublicComponentOwner(interaction);
      const [, startDate, endDate, minimum, page] = interaction.customId.split(":");
      return renderLeaderboard(this.ctx, interaction, startDate!, endDate!, Number(minimum), Number(page));
    }
    if (interaction.customId.startsWith("editended:")) {
      return showEditEndedModal(this.ctx, interaction, interaction.customId.slice("editended:".length));
    }
    if (interaction.customId.startsWith("remove:")) {
      return removeSession(this.ctx, interaction, interaction.customId.slice(7));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<InteractionOutcome | void> {
    if (interaction.customId === HISTORY_IDS.manage) {
      await this.requireOwnerIfPublic(interaction);
      return showManagePanel(this.ctx, interaction);
    }
    if (interaction.customId !== "leaderboard-user") return;
    await this.requirePublicComponentOwner(interaction);
    await this.ctx.requirePermission(interaction, PermissionLevel.STAFF);
    return replyHistory(this.ctx, interaction, { identityId: interaction.values[0]! }, "public");
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
