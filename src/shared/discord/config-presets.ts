import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  RoleSelectMenuBuilder, StringSelectMenuBuilder,
  type APIEmbedField, type MessageActionRowComponentBuilder,
} from "discord.js";
import { userError } from "../../core/errors.js";
import { BRAND_COLOR } from "./colors.js";
import { configCustomId, type ConfigComponentInteraction, type ConfigRow, type ConfigView } from "./config-section.js";

/**
 * The shared vocabulary every `/config` page is built from. A section describes
 * what it wants to show — a summary, some fields, a few controls — and these
 * presets decide what it looks like, so the pages features contribute
 * independently still read as one panel. Prefer extending a preset here over
 * hand-building an embed, button, or select menu inside a section.
 */

/** Everything the panel needs to identify a page. Declared once per section. */
export type ConfigSectionMeta = {
  /** Custom id namespace, unique across features. */
  id: string;
  label: string;
  emoji: string;
  /** One line, shown in the navigation menu and on the panel home page. */
  description: string;
};

/** The part of a section a component preset needs. */
type SectionRef = Pick<ConfigSectionMeta, "id">;

/**
 * Discord allows five action rows per message and the panel appends its own
 * navigation row.
 */
export const CONFIG_MAX_ROWS = 4;

/** Discord allows 25 options in a select menu. */
export const SELECT_OPTION_LIMIT = 25;

/** The channel types a section means when it asks for a "text channel". */
export const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

/** How every page says a setting has no value yet. */
export const NOT_CONFIGURED = "Not configured";

/* -------------------------------------------------------------------------- */
/* Field values                                                               */
/* -------------------------------------------------------------------------- */

/** A channel mention, or the shared "not configured" wording. */
export function channelValue(channelId: string | null | undefined): string {
  return channelId ? `<#${channelId}>` : NOT_CONFIGURED;
}

/** A role mention, or the shared "not configured" wording. */
export function roleValue(roleId: string | null | undefined): string {
  return roleId ? `<@&${roleId}>` : NOT_CONFIGURED;
}

/** How every page renders an on/off switch's current position. */
export function enabledValue(enabled: boolean): string {
  return enabled ? "🟢 Enabled" : "🔴 Disabled";
}

/** A number given the weight of a headline figure. */
export function countValue(count: number): string {
  return `**${count}**`;
}

/**
 * A Discord timestamp, rendered in each reader's own locale and timezone. `f`
 * is an absolute date and time; `R` is relative, as in "3 hours ago".
 */
export function timeValue(at: Date | null | undefined, style: "f" | "R" = "f", fallback = NOT_CONFIGURED): string {
  return at ? `<t:${Math.floor(at.getTime() / 1000)}:${style}>` : fallback;
}

/**
 * A page's health block: every problem as its own warning line, or a single
 * confirmation when there is nothing to report.
 */
export function problemsValue(problems: string[], healthy = "✅ No problems detected"): string {
  return problems.length ? problems.map((problem) => `⚠️ ${problem}`).join("\n") : healthy;
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A short status field. These sit side by side, so keep the value to a mention,
 * a number, or a couple of words.
 */
export function field(name: string, value: string): APIEmbedField {
  return { name, value, inline: true };
}

/** A full-width field, for prose explaining what a control does. */
export function note(name: string, value: string): APIEmbedField {
  return { name, value, inline: false };
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                      */
/* -------------------------------------------------------------------------- */

export type ConfigPage = {
  /** Lead paragraph. An array is joined with newlines. */
  summary: string | string[];
  fields?: APIEmbedField[];
  rows?: ConfigRow[];
  /** Overrides the section title, for a sub-page such as a confirmation step. */
  title?: string;
};

/**
 * Builds a page in the panel's house style: the section's own emoji and label
 * as the title, the brand colour, and at most the four action rows the panel
 * leaves a section.
 */
export function configPage(section: ConfigSectionMeta, page: ConfigPage): ConfigView {
  const rows = page.rows ?? [];
  if (rows.length > CONFIG_MAX_ROWS) {
    throw new Error(`Configuration page "${section.id}" needs ${rows.length} action rows; the panel leaves ${CONFIG_MAX_ROWS}`);
  }
  const embed = new EmbedBuilder()
    .setTitle(page.title ?? `${section.emoji} ${section.label}`)
    .setDescription(Array.isArray(page.summary) ? page.summary.join("\n") : page.summary)
    .setColor(BRAND_COLOR);
  if (page.fields?.length) embed.addFields(page.fields);
  return { embeds: [embed], components: rows };
}

/* -------------------------------------------------------------------------- */
/* Rows and controls                                                          */
/* -------------------------------------------------------------------------- */

/** Wraps controls in the action row Discord requires. */
export function configRow(...components: MessageActionRowComponentBuilder[]): ConfigRow {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);
}

/** A picker for a text or announcement channel, on a row of its own. */
export function textChannelSelect(section: SectionRef, action: string, placeholder: string): ConfigRow {
  return configRow(new ChannelSelectMenuBuilder()
    .setCustomId(configCustomId(section.id, action))
    .setPlaceholder(placeholder)
    .setChannelTypes(...TEXT_CHANNEL_TYPES));
}

/** A picker for a forum channel, on a row of its own. */
export function forumChannelSelect(section: SectionRef, action: string, placeholder: string): ConfigRow {
  return configRow(new ChannelSelectMenuBuilder()
    .setCustomId(configCustomId(section.id, action))
    .setPlaceholder(placeholder)
    .setChannelTypes(ChannelType.GuildForum));
}

/** A picker for a server role, on a row of its own. */
export function roleSelect(section: SectionRef, action: string, placeholder: string): ConfigRow {
  return configRow(new RoleSelectMenuBuilder()
    .setCustomId(configCustomId(section.id, action))
    .setPlaceholder(placeholder));
}

export type ConfigOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  default?: boolean;
};

/**
 * A menu of the section's own options, on a row of its own. Anything past
 * Discord's option limit is dropped rather than rejected.
 */
export function optionSelect(section: SectionRef, action: string, placeholder: string, options: ConfigOption[]): ConfigRow {
  return configRow(new StringSelectMenuBuilder()
    .setCustomId(configCustomId(section.id, action))
    .setPlaceholder(placeholder)
    .addOptions(options.slice(0, SELECT_OPTION_LIMIT).map((option) => ({
      ...option,
      label: option.label.slice(0, 100),
      ...(option.description ? { description: option.description.slice(0, 100) } : {}),
    }))));
}

export type ConfigButton = {
  emoji?: string;
  style?: ButtonStyle;
  disabled?: boolean;
};

/** A button that runs one of the section's actions. */
export function actionButton(section: SectionRef, action: string, label: string, options: ConfigButton = {}): ButtonBuilder {
  const button = new ButtonBuilder()
    .setCustomId(configCustomId(section.id, action))
    .setLabel(label)
    .setStyle(options.style ?? ButtonStyle.Secondary);
  if (options.emoji) button.setEmoji(options.emoji);
  if (options.disabled) button.setDisabled(true);
  return button;
}

/**
 * The switch a page's main feature is turned on and off with. It carries the
 * intended position in its custom id, so a stale panel cannot toggle the wrong
 * way; read it back with `toggleChoice`.
 */
export function toggleButton(section: SectionRef, action: string, enabled: boolean, subject: string): ButtonBuilder {
  return actionButton(
    section,
    `${action}:${enabled ? "off" : "on"}`,
    `${enabled ? "Disable" : "Enable"} ${subject}`,
    { style: enabled ? ButtonStyle.Danger : ButtonStyle.Success },
  );
}

/**
 * Reads a `toggleButton` press: `true` to enable, `false` to disable, and
 * `null` when the action belongs to some other control.
 */
export function toggleChoice(action: string, name: string): boolean | null {
  if (action === `${name}:on`) return true;
  if (action === `${name}:off`) return false;
  return null;
}

/** Re-renders the page. Every section showing live state offers one. */
export function refreshButton(section: SectionRef, action = "refresh"): ButtonBuilder {
  return actionButton(section, action, "Refresh", { emoji: "🔄", style: ButtonStyle.Primary });
}

/** Leaves a sub-page for the section's main view. */
export function backButton(section: SectionRef, action = "back"): ButtonBuilder {
  return actionButton(section, action, "Back", { style: ButtonStyle.Secondary });
}

/* -------------------------------------------------------------------------- */
/* Reading interactions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The channel a picker returned, rejected with the section's own wording when
 * it is not of the kind that control asked for. Discord already filters the
 * menu, so a mismatch means a crafted interaction rather than a mistake.
 */
export function selectedChannel(
  interaction: ConfigComponentInteraction,
  kind: "text" | "forum",
  requirement: string,
): { id: string } {
  if (!interaction.isChannelSelectMenu()) userError(requirement);
  const channel = interaction.channels.first();
  if (!channel) userError(requirement);
  const allowed: readonly ChannelType[] = kind === "forum" ? [ChannelType.GuildForum] : TEXT_CHANNEL_TYPES;
  if (!allowed.includes(channel.type)) userError(requirement);
  return { id: channel.id };
}

/** The single value a role or option menu returned. */
export function selectedValue(interaction: ConfigComponentInteraction, requirement: string): string {
  if (!interaction.isRoleSelectMenu() && !interaction.isStringSelectMenu()) userError(requirement);
  const value = interaction.values[0];
  if (!value) userError(requirement);
  return value;
}
