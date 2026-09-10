import {
  EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type Client, type Interaction,
} from "discord.js";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import type { HelpSection } from "../../../shared/discord/help.js";
import { permissionLabel, permissionLevelFor, PermissionLevel } from "../../../shared/permissions.js";

/**
 * `/help` lists the commands of every feature that was actually composed, so it
 * can never advertise something the bot ignores. Commands the caller cannot use
 * are still listed, marked with the level they need.
 */
export class HelpCommandHandler {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly sections: HelpSection[],
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The command list could not be loaded. Please try again later.";
      if (!(error instanceof UserFacingError)) console.error("Help interaction failed", { errorType: errorType(error) });
      if (!interaction.isRepliable()) return;
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        console.error("Failed to deliver help interaction error", { errorType: errorType(replyError) });
      }
    }));
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "help") return;
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    await this.reply(interaction);
  }

  private async reply(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const level = await permissionLevelFor(this.db, interaction);
    await interaction.editReply({ embeds: [helpEmbed(this.sections, level)] });
  }
}

/** A lock for anything above the caller's level, a tick for what they can run. */
function marker(required: number, level: number): string {
  return level >= required ? "✅" : "🔒";
}

export function helpEmbed(sections: HelpSection[], level: number): EmbedBuilder {
  const usable = sections.flatMap(({ commands }) => commands).filter((command) => level >= command.permission).length;
  return new EmbedBuilder()
    .setTitle("📖 Commands")
    .setDescription([
      `Your access level is **${level === PermissionLevel.EVERYONE ? "Everyone" : permissionLabel(level)}**, so you can run **${usable}** of these commands.`,
      "✅ you can run · 🔒 needs a higher role.",
    ].join("\n"))
    .setColor(BRAND_COLOR)
    .addFields(sections.map((section) => ({
      name: `${section.emoji} ${section.title}`,
      value: section.commands.map((command) => {
        const required = command.permission === PermissionLevel.EVERYONE ? "Everyone" : permissionLabel(command.permission);
        return `${marker(command.permission, level)} \`${command.usage}\` — ${command.description}\n↳ *${required}*`;
      }).join("\n"),
      inline: false,
    })))
    .setFooter({ text: "Access is cumulative: you get the highest level of any role you hold." });
}
