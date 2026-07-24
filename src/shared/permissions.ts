import { GuildMember, PermissionFlagsBits, type Interaction } from "discord.js";
import type { Db } from "../core/db.js";

export const PermissionLevel = {
  EVERYONE: 1,
  STAFF: 2,
  ADMIN: 3,
  MANAGER: 4,
} as const;

export function permissionLabel(level: number): string {
  return level === PermissionLevel.MANAGER ? "Manager" : level === PermissionLevel.ADMIN ? "Admin" : "Staff";
}

function memberRoleIds(interaction: Interaction): string[] {
  if (!interaction.member) return [];
  return interaction.member instanceof GuildMember ? [...interaction.member.roles.cache.keys()] : interaction.member.roles;
}

function hasDiscordAdministrator(interaction: Interaction): boolean {
  if (!interaction.member) return false;
  if (interaction.member instanceof GuildMember) return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  return (BigInt(interaction.member.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
}

/**
 * Access is cumulative: guild administrators always have manager access, and
 * everyone else takes the highest level of any of their configured roles.
 */
export async function permissionLevelFor(db: Db, interaction: Interaction): Promise<number> {
  if (hasDiscordAdministrator(interaction)) return PermissionLevel.MANAGER;
  const roleIds = memberRoleIds(interaction);
  const configured = roleIds.length
    ? await db.permissionRole.findMany({ where: { roleId: { in: roleIds } }, select: { level: true } })
    : [];
  return Math.max(PermissionLevel.EVERYONE, ...configured.map(({ level }) => level));
}

export async function hasPermission(db: Db, interaction: Interaction, required: number): Promise<boolean> {
  return (await permissionLevelFor(db, interaction)) >= required;
}
