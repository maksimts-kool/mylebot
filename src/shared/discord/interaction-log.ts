import type { CommandInteractionOption, Interaction } from "discord.js";
import { UserFacingError, errorType } from "../../core/errors.js";
import type { LogFields, Logger } from "../../core/logger.js";

/**
 * What one interaction did, for the line it is logged as. `did` is a short
 * sentence in the past tense, lower case — `sent the profile card for wolfik` —
 * and `fields` carries the numbers behind it, such as how many shifts were read.
 */
export type InteractionOutcome = {
  did: string;
  fields?: LogFields;
};

/** A component's own label reads better in a log than its custom ID. */
function readable(text: string | null | undefined): string | null {
  // Placeholders lead with an emoji; the words are what a reader greps for.
  const words = text?.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return words ? words : null;
}

/**
 * How a log line names an interaction: `/session view`, `Next button`,
 * `Go to a configuration page menu`, `form`. A component is named by what the
 * person clicking it saw, falling back to its custom ID's first segment.
 */
export function interactionName(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    return [`/${interaction.commandName}`, group, subcommand].filter(Boolean).join(" ");
  }
  const fallback = ("customId" in interaction ? interaction.customId.split(":")[0] : undefined) || "interaction";
  if (interaction.isButton()) {
    const label = "label" in interaction.component ? interaction.component.label : null;
    return `${readable(label) ?? fallback} button`;
  }
  if (interaction.isAnySelectMenu()) {
    const placeholder = "placeholder" in interaction.component ? interaction.component.placeholder : null;
    return `${readable(placeholder) ?? fallback} menu`;
  }
  if (interaction.isModalSubmit()) return "form";
  if (interaction.isCommand()) return `/${interaction.commandName}`;
  return fallback;
}

/** One option's value as a name a person recognises, never a raw snowflake. */
function optionValue(option: CommandInteractionOption): unknown {
  if (option.user) return option.user.username;
  if (option.role) return `@${option.role.name}`;
  if (option.channel && "name" in option.channel && option.channel.name) return `#${option.channel.name}`;
  return option.value;
}

/** The options a slash command was run with, flattened: `user=wolfik period=week`. */
export function commandOptions(interaction: Interaction): LogFields {
  if (!interaction.isChatInputCommand()) return {};
  const fields: LogFields = {};
  const visit = (options: readonly CommandInteractionOption[]) => {
    for (const option of options) {
      if (option.options) visit(option.options);
      else if (option.value !== undefined || option.user || option.role || option.channel) fields[option.name] = optionValue(option);
    }
  };
  visit(interaction.options.data);
  return fields;
}

/**
 * The single line each interaction leaves behind: who did it, what they asked
 * for, and what the bot did about it — sent a card, refused with a reason, or
 * failed with an error. A handler creates one per interaction it owns and
 * settles it exactly once.
 */
export class InteractionLog {
  private readonly startedAt = Date.now();
  private readonly name: string;
  private readonly fields: LogFields;

  constructor(interaction: Interaction, private readonly log: Logger) {
    this.name = interactionName(interaction);
    this.fields = { actor: interaction.user.username, ...commandOptions(interaction) };
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }

  /** It worked: `/profile → sent the profile card for wolfik`. */
  done(outcome: InteractionOutcome | void): void {
    this.log.info(
      { ...this.fields, ...outcome?.fields, durationMs: this.elapsed() },
      `${this.name} → ${outcome?.did ?? "done"}`,
    );
  }

  /**
   * Settles from an error. A user-facing error is the bot saying no — missing
   * role, nothing tracked yet — which is worth knowing but not an alarm; anything
   * else is a failure with its stack.
   */
  failed(error: unknown): void {
    if (error instanceof UserFacingError) {
      this.log.info({ ...this.fields, durationMs: this.elapsed() }, `${this.name} → refused: ${error.message}`);
      return;
    }
    this.log.error({ ...this.fields, err: error, errorType: errorType(error), durationMs: this.elapsed() }, `${this.name} failed`);
  }
}
