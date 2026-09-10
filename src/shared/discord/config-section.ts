import type {
  ActionRowBuilder, ButtonInteraction, ChannelSelectMenuInteraction, EmbedBuilder,
  MessageActionRowComponentBuilder, RoleSelectMenuInteraction, StringSelectMenuInteraction,
} from "discord.js";

/** One action row of the configuration panel. */
export type ConfigRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

/**
 * A rendered section body. Discord allows five action rows per message and the
 * panel appends its own navigation row, so a section may contribute four.
 */
export type ConfigView = {
  embeds: EmbedBuilder[];
  components: ConfigRow[];
};

/** The component interactions a section can be asked to apply. */
export type ConfigComponentInteraction =
  | ButtonInteraction
  | ChannelSelectMenuInteraction
  | RoleSelectMenuInteraction
  | StringSelectMenuInteraction;

/**
 * One page of `/config`. Features contribute their own settings this way
 * instead of owning a command each, so every server setting lives behind a
 * single panel. The panel owns the command, the permission check, navigation,
 * and the acknowledgement; a section only renders itself and applies its own
 * component interactions.
 */
export interface ConfigSection {
  /** Custom id namespace, unique across features. */
  id: string;
  label: string;
  emoji: string;
  /** One line, shown in the navigation menu and on the panel home page. */
  description: string;
  /** Renders the section from current state. Called for every navigation. */
  view(): Promise<ConfigView>;
  /**
   * Applies an interaction whose custom id starts with `config:<id>:`. The
   * interaction is already acknowledged with a deferred update, so reply by
   * returning the view to show. Returning `null` re-renders the section.
   */
  apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null>;
}

/** Builds the namespaced custom id a section's components must carry. */
export function configCustomId(sectionId: string, action: string): string {
  return `config:${sectionId}:${action}`;
}
