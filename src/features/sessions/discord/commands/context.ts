import type { ButtonInteraction, Interaction, StringSelectMenuInteraction } from "discord.js";
import type { Config } from "../../../../core/config.js";
import type { Db } from "../../../../core/db.js";
import type { BloxlinkService } from "../../../../shared/bloxlink.js";
import type { PublicComponentTracker } from "../../../../shared/discord/components.js";
import type { RuntimeSettingsService } from "../../../../shared/runtime-settings.js";
import type { DiscordPublisher } from "../publisher.js";

/**
 * Everything the individual command modules need. The handler owns the shared
 * state and the permission checks; the modules stay free of wiring.
 */
export interface SessionCommandContext {
  db: Db;
  config: Config;
  publisher: DiscordPublisher;
  bloxlink: BloxlinkService;
  settings: RuntimeSettingsService;
  publicComponents: PublicComponentTracker;
  /** Throws a user-facing "<Level> role required" error when the caller is short. */
  requirePermission(interaction: Interaction, required: number, message?: string): Promise<void>;
  hasPermission(interaction: Interaction, required: number): Promise<boolean>;
  /** Rejects anyone but the person who ran a publicly visible command. */
  requirePublicComponentOwner(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void>;
}
