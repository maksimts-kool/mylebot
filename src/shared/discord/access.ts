import { GuildMember, PermissionFlagsBits, type Interaction } from "discord.js";
import { userError } from "../../core/errors.js";
import { PermissionLevel, permissionLabel } from "../permissions.js";
import type { SharedServerPort } from "../server-port.js";

function memberRoleIds(interaction: Interaction): string[] {
  if (!interaction.member) return [];
  return interaction.member instanceof GuildMember ? [...interaction.member.roles.cache.keys()] : interaction.member.roles;
}

function hasDiscordAdministrator(interaction: Interaction): boolean {
  if (!interaction.member) return false;
  if (interaction.member instanceof GuildMember) return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  return (BigInt(interaction.member.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
}

/** Who may ask: the shared port's `permissionLevel` is the only part needed here. */
export type AccessSource = Pick<SharedServerPort, "permissionLevel">;

/**
 * Access is cumulative: guild administrators always have manager access, and
 * everyone else takes the highest level of any of their configured roles. The
 * roles come off the interaction; which level each grants lives with the server.
 */
export async function permissionLevelFor(access: AccessSource, interaction: Interaction): Promise<number> {
  if (hasDiscordAdministrator(interaction)) return PermissionLevel.MANAGER;
  const roleIds = memberRoleIds(interaction);
  return roleIds.length ? access.permissionLevel(roleIds) : PermissionLevel.EVERYONE;
}

export async function hasPermission(access: AccessSource, interaction: Interaction, required: number): Promise<boolean> {
  return (await permissionLevelFor(access, interaction)) >= required;
}

/** Throws a user-facing "<Level> role required" error when the caller is short. */
export async function requirePermission(
  access: AccessSource,
  interaction: Interaction,
  required: number,
  message?: string,
): Promise<void> {
  if (!await hasPermission(access, interaction, required)) userError(message ?? `${permissionLabel(required)} role required`);
}
