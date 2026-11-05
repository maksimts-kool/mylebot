import type { ServerCapabilities } from "../core/feature.js";
import type { PermissionRoleRow } from "./permission-roles.js";

/** The port every feature's Discord surface shares. */
export const SHARED_PORT = "shared";

/** The bot half's handle on the gateway, which the server half asks about at startup. */
export const BOT_CORE_PORT = "core";

export type RobloxMapping = { userId: bigint; username: string };

/**
 * What the server half offers every feature's Discord surface: who may do
 * what, and who somebody is on Roblox. Feature-specific state has a port of
 * its own, named after the feature.
 */
export interface SharedServerPort {
  /** Which features the server half runs. Asked once, before the bot logs in. */
  capabilities(): Promise<ServerCapabilities>;
  /** The gateway is ready. The server half catches Discord up on what it missed. */
  botReady(): Promise<void>;
  /** The highest level any of these Discord roles grants, never below Everyone. */
  permissionLevel(roleIds: string[]): Promise<number>;
  /** The Roblox account linked to a Discord member, through Bloxlink. */
  robloxForDiscord(discordUserId: string): Promise<RobloxMapping | null>;
  /** Every role that grants access, for the `/config` role permissions page. */
  permissionRoles(): Promise<PermissionRoleRow[]>;
  permissionRole(roleId: string): Promise<PermissionRoleRow | null>;
  setPermissionRole(roleId: string, level: number): Promise<void>;
  removePermissionRole(roleId: string): Promise<void>;
}

/** What the bot half offers the server half about the gateway itself. */
export interface BotCorePort {
  /** Whether the gateway is connected, so the server knows whether to catch Discord up now. */
  status(): Promise<{ discordReady: boolean }>;
}
