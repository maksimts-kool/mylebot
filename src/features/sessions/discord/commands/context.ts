import type { ButtonInteraction, Interaction, StringSelectMenuInteraction } from "discord.js";
import type { Config } from "../../../../core/config.js";
import type { PublicComponentTracker } from "../../../../shared/discord/components.js";
import type { SharedServerPort } from "../../../../shared/server-port.js";
import type { SessionsServerPort } from "../../link.js";

/**
 * Everything the individual command modules need. The handler owns the shared
 * state and the permission checks; the modules stay free of wiring. Session
 * state lives with the server half, reached through `sessions`.
 */
export interface SessionCommandContext {
  config: Config;
  sessions: SessionsServerPort;
  shared: SharedServerPort;
  publicComponents: PublicComponentTracker;
  /** Throws a user-facing "<Level> role required" error when the caller is short. */
  requirePermission(interaction: Interaction, required: number, message?: string): Promise<void>;
  hasPermission(interaction: Interaction, required: number): Promise<boolean>;
  /** Rejects anyone but the person who ran a publicly visible command. */
  requirePublicComponentOwner(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void>;
}
