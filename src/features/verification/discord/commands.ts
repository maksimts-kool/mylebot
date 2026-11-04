import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { appLogger } from "../../../core/logger.js";
import type { HelpSection } from "../../../shared/discord/help.js";
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

export const verificationHelp: HelpSection = {
  title: "Verification",
  emoji: "🔐",
  commands: [
    { usage: "/verification status", description: "Shows every unverified member, whether their final warning was sent, and when removal becomes due.", permission: PermissionLevel.MANAGER },
  ],
};

function discordTimestamp(date: Date, style: "F" | "R"): string {
  return `<t:${Math.floor(date.getTime() / 1_000)}:${style}>`;
}

function memberField(member: VerificationStatusMember, now: Date): { name: string; value: string; inline: false } {
  const profileLink = `[@${escapeMarkdown(member.displayName)}](https://discord.com/users/${member.discordUserId})`;
  const memberLine = `**Member:** ${profileLink}`;
  if (member.firstSeenAt === null || member.finalWarningDueAt === null || member.removalDueAt === null) {
    return {
      name: "🆕 New",
      value: `${memberLine}\n**Final warning:** ❌ Not sent\n**Tracking:** Starts during the next reminder cycle\n**Removal:** No deadline yet`,
      inline: false,
    };
  }
  if (member.warnedAt !== null) {
    const dueNow = member.removalDueAt.getTime() <= now.getTime();
    return {
      name: `${dueNow ? "🚨 Removal due" : "⚠️ Final warning sent"}`,
      value: `${memberLine}\n**Final warning:** ✅ Sent ${discordTimestamp(member.warnedAt, "R")}\n**Removal:** ${dueNow ? "🚨 **Due now**" : `⏳ ${discordTimestamp(member.removalDueAt, "R")}`} • ${discordTimestamp(member.removalDueAt, "F")}`,
      inline: false,
    };
  }
  if (member.finalWarningDueAt.getTime() <= now.getTime()) {
    return {
      name: "📣 Warning due",
      value: `${memberLine}\n**Final warning:** ❌ Not sent — **due now**\n**Removal:** 🔒 Blocked until 3 full days after a successful warning`,
      inline: false,
    };
  }
  return {
    name: "⏳ Waiting",
    value: `${memberLine}\n**Tracking since:** ${discordTimestamp(member.firstSeenAt, "F")}\n**Final warning:** ${discordTimestamp(member.finalWarningDueAt, "R")}\n**Earliest removal:** ${discordTimestamp(member.removalDueAt, "F")}`,
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
        text: `${start + 1}–${start + members.length} of ${status.members.length} • Click a name to open their profile`,
      }));
  }
  return embeds;
}

/** The button under the last status message, which takes the whole dashboard down. */
export const VERIFICATION_CLOSE_ID = "verification:close";

/**
 * An interaction token lives for 15 minutes, and only the command's own token
 * can delete the earlier messages of a private reply. Forget it a minute early.
 */
const OPEN_DASHBOARD_MS = 14 * 60_000;

/** Discord's "Unknown Message": the member already dismissed that part. */
const UNKNOWN_MESSAGE = 10008;

export function closeRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(VERIFICATION_CLOSE_ID).setLabel("Close").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
  );
}

type OpenDashboard = {
  command: ChatInputCommandInteraction;
  /** Every message above the one carrying the close button, oldest first. */
  earlier: string[];
  timeout: NodeJS.Timeout;
};

export class VerificationCommandHandler {
  /** Dashboards still closable as a whole, keyed by their last message. */
  private readonly open = new Map<string, OpenDashboard>();

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly service: VerificationService,
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The verification status could not be loaded. Please try again later.";
      if (!(error instanceof UserFacingError)) appLogger().error({ category: "verify", err: error, errorType: errorType(error) }, "Verification command failed");
      if (!interaction.isRepliable()) return;
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
        else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        appLogger().error({ category: "verify", err: replyError, errorType: errorType(replyError) }, "Could not tell the user the command failed");
      }
    }));
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isButton() && interaction.customId === VERIFICATION_CLOSE_ID) {
      await this.close(interaction);
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== "verification") return;
    if (interaction.guildId !== this.config.DISCORD_GUILD_ID) userError("This command is not available in this server");
    if (!await hasPermission(this.db, interaction, PermissionLevel.MANAGER)) userError("Manager role required");
    await this.replyStatus(interaction);
  }

  private async replyStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embeds = verificationStatusEmbeds(await this.service.status());
    const sent: string[] = [];
    for (const [index, embed] of embeds.entries()) {
      const last = index === embeds.length - 1;
      const body = { embeds: [embed], allowedMentions: { parse: [] }, components: last ? [closeRow()] : [] };
      const message = index === 0
        ? await interaction.editReply(body)
        : await interaction.followUp({ ...body, flags: MessageFlags.Ephemeral });
      sent.push(message.id);
    }
    const lastId = sent.pop();
    if (!lastId) return;
    const timeout = setTimeout(() => this.open.delete(lastId), OPEN_DASHBOARD_MS);
    timeout.unref();
    this.open.set(lastId, { command: interaction, earlier: sent, timeout });
  }

  /**
   * Takes the dashboard down. While the command's token is still valid that is
   * every message it sent; after that, only the one the button is on.
   */
  private async close(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const dashboard = this.open.get(interaction.message.id);
    if (dashboard) {
      this.open.delete(interaction.message.id);
      clearTimeout(dashboard.timeout);
      const results = await Promise.allSettled(dashboard.earlier.map((id, index) => (
        index === 0 ? dashboard.command.deleteReply() : dashboard.command.deleteReply(id)
      )));
      for (const result of results) {
        if (result.status === "fulfilled") continue;
        if (result.reason instanceof DiscordAPIError && result.reason.code === UNKNOWN_MESSAGE) continue;
        appLogger().warn({ category: "verify", err: result.reason }, "Could not take down part of the verification dashboard");
      }
    }
    await interaction.deleteReply(interaction.message.id);
  }
}
