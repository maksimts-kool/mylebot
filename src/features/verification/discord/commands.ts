import {
  EmbedBuilder,
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

function memberField(member: VerificationStatusMember, now: Date): { name: string; value: string; inline: false } {
  const mention = `<@${member.discordUserId}>`;
  if (member.firstSeenAt === null || member.finalWarningDueAt === null || member.removalDueAt === null) {
    return {
      name: `🆕 ${mention} • New`,
      value: "**Final warning:** ❌ Not sent\n**Tracking:** Starts during the next reminder cycle\n**Removal:** No deadline yet",
      inline: false,
    };
  }
  if (member.warnedAt !== null) {
    const dueNow = member.removalDueAt.getTime() <= now.getTime();
    return {
      name: `${dueNow ? "🚨" : "⚠️"} ${mention} • ${dueNow ? "Removal due" : "Final warning sent"}`,
      value: `**Final warning:** ✅ Sent ${discordTimestamp(member.warnedAt, "R")}\n**Removal:** ${dueNow ? "🚨 **Due now**" : `⏳ ${discordTimestamp(member.removalDueAt, "R")}`} • ${discordTimestamp(member.removalDueAt, "F")}`,
      inline: false,
    };
  }
  if (member.finalWarningDueAt.getTime() <= now.getTime()) {
    return {
      name: `📣 ${mention} • Warning due`,
      value: "**Final warning:** ❌ Not sent — **due now**\n**Removal:** 🔒 Blocked until 3 full days after a successful warning",
      inline: false,
    };
  }
  return {
    name: `⏳ ${mention} • Waiting`,
    value: `**Tracking since:** ${discordTimestamp(member.firstSeenAt, "F")}\n**Final warning:** ${discordTimestamp(member.finalWarningDueAt, "R")}\n**Earliest removal:** ${discordTimestamp(member.removalDueAt, "F")}`,
    inline: false,
  };
}

const MEMBER_PAGE_SIZE = 20;
const COLOR_GREEN = 0x57f287;
const COLOR_YELLOW = 0xfee75c;
const COLOR_RED = 0xed4245;
const COLOR_BLUE = 0x5865f2;

/** Build a private dashboard followed by paginated live-member embeds. */
export function verificationStatusEmbeds(status: VerificationStatus, now = new Date()): EmbedBuilder[] {
  const warned = status.members.filter((member) => member.warnedAt !== null).length;
  const dueNow = status.members.filter((member) => member.warnedAt !== null
    && member.removalDueAt !== null
    && member.removalDueAt.getTime() <= now.getTime()).length;
  const untracked = status.members.filter((member) => member.firstSeenAt === null).length;
  const reminder = status.lastReminderAt === null
    ? "❌ No successful reminder recorded yet"
    : `✅ Last sent ${discordTimestamp(status.lastReminderAt, "R")}${status.nextReminderAt ? `\n⏰ Next due ${discordTimestamp(status.nextReminderAt, "R")}` : ""}`;
  const summaryColor = dueNow ? COLOR_RED : warned ? COLOR_YELLOW : status.members.length ? COLOR_BLUE : COLOR_GREEN;
  const summary = new EmbedBuilder()
    .setTitle("🔐 Verification Timeout Dashboard")
    .setDescription(status.members.length
      ? "Live status for everyone currently holding the **Unverified** role."
      : "✅ Nobody currently holds the **Unverified** role.")
    .setColor(summaryColor)
    .addFields(
      { name: "👥 Unverified", value: `**${status.members.length}**`, inline: true },
      { name: "⚠️ Warnings sent", value: `**${warned}**`, inline: true },
      { name: "🚨 Removal due", value: `**${dueNow}**`, inline: true },
      { name: "🆕 Not tracked", value: `**${untracked}**`, inline: true },
      { name: "📨 Role reminder", value: reminder, inline: true },
      {
        name: "🛡️ Removal safeguard",
        value: "A member can only be removed after their final warning was sent successfully and a full **3 days** passed.",
        inline: false,
      },
    )
    .setFooter({ text: "Private manager view • Live Discord role membership" })
    .setTimestamp(now);
  if (status.staleTrackedCount) {
    summary.addFields({
      name: "🧹 Pending cleanup",
      value: `**${status.staleTrackedCount}** stored ${status.staleTrackedCount === 1 ? "entry no longer holds" : "entries no longer hold"} the role and will be cleared during the next reminder cycle.`,
      inline: false,
    });
  }

  const embeds = [summary];
  const pageCount = Math.ceil(status.members.length / MEMBER_PAGE_SIZE);
  for (let page = 0; page < pageCount; page += 1) {
    const start = page * MEMBER_PAGE_SIZE;
    const members = status.members.slice(start, start + MEMBER_PAGE_SIZE);
    embeds.push(new EmbedBuilder()
      .setTitle(`👥 Unverified Members • Page ${page + 1}/${pageCount}`)
      .setDescription("🚨 Removal due  •  ⚠️ Warned  •  📣 Warning due  •  ⏳ Waiting  •  🆕 New")
      .setColor(summaryColor)
      .addFields(members.map((member) => memberField(member, now)))
      .setFooter({
        text: `${start + 1}–${start + members.length} of ${status.members.length} • Mentions do not send notifications`,
      }));
  }
  return embeds;
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
    const embeds = verificationStatusEmbeds(await this.service.status());
    const first = embeds[0];
    if (!first) return;
    await interaction.editReply({ embeds: [first], allowedMentions: { parse: [] } });
    for (const embed of embeds.slice(1)) {
      await interaction.followUp({ embeds: [embed], allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
    }
  }
}
