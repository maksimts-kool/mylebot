import { GuildMember, PermissionFlagsBits, type Interaction } from "discord.js";
import { PermissionLevel, RANKS, RANK_CODES, type RankDef } from "../domain/ranks.js";
import type { Actor } from "../services/staff-service.js";
import type { Store } from "../store/store.js";

function memberRoleIds(interaction: Interaction): string[] {
  if (!interaction.member) return [];
  return interaction.member instanceof GuildMember ? [...interaction.member.roles.cache.keys()] : interaction.member.roles;
}

function hasAdministrator(interaction: Interaction): boolean {
  if (!interaction.member) return false;
  if (interaction.member instanceof GuildMember) return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  return (BigInt(interaction.member.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
}

/**
 * Resolve who the interacting user is for governance:
 * - `rank`: the highest rank they hold, taken from a configured rank→role mapping
 *   OR their StaffMember record (whichever is more senior).
 * - `managerOverride`: Discord Administrators are treated as Staff Manager.
 */
export function resolveActor(interaction: Interaction, store: Store): Actor {
  const roleIds = memberRoleIds(interaction);
  let rank: RankDef | null = null;
  const consider = (def: RankDef): void => {
    if (!rank || def.order > rank.order) rank = def;
  };
  for (const code of RANK_CODES) {
    const configured = store.getRankConfig(code).discordRoleId;
    if (configured && roleIds.includes(configured)) consider(RANKS[code]);
  }
  const staff = store.getStaffByDiscord(interaction.user.id);
  if (staff) consider(RANKS[staff.rank]);
  return { discordUserId: interaction.user.id, rank, managerOverride: hasAdministrator(interaction) };
}

/** Effective bot permission level (STAFF/ADMIN/MANAGER), Administrator = MANAGER. */
export function botLevel(actor: Actor): number {
  if (actor.managerOverride) return PermissionLevel.MANAGER;
  return actor.rank ? actor.rank.botLevel : PermissionLevel.EVERYONE;
}

export function hasBotLevel(actor: Actor, required: number): boolean {
  return botLevel(actor) >= required;
}
