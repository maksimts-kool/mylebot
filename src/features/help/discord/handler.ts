import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { Config } from "../../../core/config.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import { appLogger } from "../../../core/logger.js";
import { permissionLevelFor, type AccessSource } from "../../../shared/discord/access.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import type { HelpSection } from "../../../shared/discord/help.js";
import { InteractionLog, type InteractionOutcome } from "../../../shared/discord/interaction-log.js";
import { permissionLabel, PermissionLevel } from "../../../shared/permissions.js";

/**
 * `/help` lists the commands of every feature that was actually composed, so it
 * can never advertise something the bot ignores. Commands the caller cannot use
 * are still listed, marked with the level they need.
 */
export class HelpCommandHandler {
  constructor(
    private readonly client: Client,
    private readonly access: AccessSource,
    private readonly config: Config,
    private readonly sections: HelpSection[],
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== "help") return;
      const trace = new InteractionLog(interaction, appLogger().child({ category: "command" }));
      void this.handle(interaction).then((outcome) => trace.done(outcome), async (error: unknown) => {
        trace.failed(error);
        const message = error instanceof UserFacingError ? error.message : "The command list could not be loaded. Please try again later.";
        try {
          if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
          else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        } catch (replyError) {
          appLogger().error({ category: "command", err: replyError, errorType: errorType(replyError) }, "Could not tell the user /help failed");
        }
      });
    });
  }

  private async handle(interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    // The list is the same for everyone, so it is answered in the channel.
    await interaction.deferReply();
    const level = await permissionLevelFor(this.access, interaction);
    await interaction.editReply({ embeds: [helpEmbed(this.sections, level)] });
    return {
      did: "sent the command list",
      fields: { access: level === PermissionLevel.EVERYONE ? "Everyone" : permissionLabel(level) },
    };
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
