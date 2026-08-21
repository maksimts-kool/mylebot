import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { PermissionLevel, hasPermission } from "../../../shared/permissions.js";
import type { VerificationService, VerificationStatus, VerificationStatusMember } from "../service/verification-service.js";

export const verificationCommandData = [
  new SlashCommandBuilder()
    .setName("verification")
    .setDescription("Inspect verification timeouts")
    .addSubcommand((subcommand) => subcommand
      .setName("status")
      .setDescription("Show pending warnings and removals")),
].map((command) => command.toJSON());

function discordTimestamp(date: Date, style: "F" | "R"): string {
  return `<t:${Math.floor(date.getTime() / 1_000)}:${style}>`;
}

function memberStatus(member: VerificationStatusMember, now: Date): string {
  const mention = `<@${member.discordUserId}>`;
  if (member.firstSeenAt === null || member.finalWarningDueAt === null || member.removalDueAt === null) {
    return `${mention} — Final warning sent: no; not tracked yet, so there is no removal deadline.`;
  }
  if (member.warnedAt !== null) {
    const removal = member.removalDueAt.getTime() <= now.getTime() ? "due now" : discordTimestamp(member.removalDueAt, "R");
    return `${mention} — Final warning sent: yes, ${discordTimestamp(member.warnedAt, "R")}; removal ${removal} (${discordTimestamp(member.removalDueAt, "F")}).`;
  }
  if (member.finalWarningDueAt.getTime() <= now.getTime()) {
    return `${mention} — Final warning sent: no; warning is due now. Removal waits until 3 days after a successful warning.`;
  }
  return `${mention} — Final warning sent: no; warning ${discordTimestamp(member.finalWarningDueAt, "R")}; earliest removal ${discordTimestamp(member.removalDueAt, "F")}.`;
}

/** Split the complete live member list without exceeding Discord's message limit. */
export function verificationStatusMessages(status: VerificationStatus, now = new Date(), limit = 2_000): string[] {
  const warned = status.members.filter((member) => member.warnedAt !== null).length;
  const dueNow = status.members.filter((member) => member.warnedAt !== null
    && member.removalDueAt !== null
    && member.removalDueAt.getTime() <= now.getTime()).length;
  const untracked = status.members.filter((member) => member.firstSeenAt === null).length;
  const reminder = status.lastReminderAt === null
    ? "Role reminder message sent: no recorded successful message."
    : `Role reminder message sent: yes — last ${discordTimestamp(status.lastReminderAt, "R")}${status.nextReminderAt ? `; next due ${discordTimestamp(status.nextReminderAt, "R")}` : ""}.`;
  const summary = [
    "Verification timeout status",
    `Currently unverified: ${status.members.length} | Final warning sent: ${warned} | Removal due now: ${dueNow} | Not tracked yet: ${untracked}`,
    reminder,
    "The member list is live. A member is removed only after their final warning was sent successfully and a full 3 days passed.",
    ...(status.staleTrackedCount
      ? [`Stored entries no longer holding the role: ${status.staleTrackedCount} (removed automatically on the next reminder cycle).`]
      : []),
  ].join("\n");

  const lines = status.members.length
    ? status.members.map((member) => memberStatus(member, now))
    : ["Nobody currently has the Unverified role."];
  const messages: string[] = [];
  let current = summary;
  for (const line of lines) {
    if (`${current}\n${line}`.length > limit) {
      messages.push(current);
      current = "Verification timeout status (continued)";
    }
    current += `\n${line}`;
  }
  messages.push(current);
  return messages;
}

export class VerificationCommandHandler {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly service: VerificationService,
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The verification status could not be loaded. Please try again later.";
      if (!(error instanceof UserFacingError)) console.error("Verification interaction failed", { errorType: errorType(error) });
      if (!interaction.isRepliable()) return;
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
        else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        console.error("Failed to deliver verification interaction error", { errorType: errorType(replyError) });
      }
    }));
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "verification") return;
    if (interaction.guildId !== this.config.DISCORD_GUILD_ID) userError("This command is not available in this server");
    if (!await hasPermission(this.db, interaction, PermissionLevel.MANAGER)) userError("Manager role required");
    await this.replyStatus(interaction);
  }

  private async replyStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const messages = verificationStatusMessages(await this.service.status());
    const first = messages[0];
    if (!first) return;
    await interaction.editReply({ content: first, allowedMentions: { parse: [] } });
    for (const content of messages.slice(1)) {
      await interaction.followUp({ content, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
    }
  }
}
