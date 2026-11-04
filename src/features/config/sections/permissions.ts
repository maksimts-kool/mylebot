import { ButtonStyle, type Client } from "discord.js";
import type { Db } from "../../../core/db.js";
import { userError } from "../../../core/errors.js";
import {
  actionButton, backButton, configPage, configRow, field, note, optionSelect, roleSelect, selectedValue,
  type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigComponentInteraction, ConfigRow, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import { PermissionLevel, permissionLabel } from "../../../shared/permissions.js";

const META: ConfigSectionMeta = {
  id: "permissions",
  label: "Role permissions",
  emoji: "🔑",
};

const ACTIONS = { role: "role", revoke: "revoke", level: "level", back: "back" } as const;

const ASSIGNABLE_LEVELS = [PermissionLevel.STAFF, PermissionLevel.ADMIN, PermissionLevel.MANAGER] as const;

/**
 * Splits `permissions:level:<roleId>:<choice>` into its parts. Exported so the
 * custom id format stays covered by a test.
 */
export function parsePermissionAction(action: string): { roleId: string; choice: string } | null {
  const prefix = `${ACTIONS.level}:`;
  if (!action.startsWith(prefix)) return null;
  const [roleId, choice] = action.slice(prefix.length).split(":");
  return roleId && choice ? { roleId, choice } : null;
}

/**
 * Create, read, update and delete the role permissions the bot grants. Guild
 * administrators always have manager access; everything else is decided here.
 */
export function permissionsSection(db: Db, client: Client, guildId: string): ConfigSection {
  function roleName(roleId: string): string {
    return client.guilds.cache.get(guildId)?.roles.cache.get(roleId)?.name ?? `Role ${roleId}`;
  }

  async function view(): Promise<ConfigView> {
    const roles = await db.permissionRole.findMany({ orderBy: [{ level: "desc" }, { createdAt: "asc" }] });
    const rows: ConfigRow[] = [roleSelect(META, ACTIONS.role, "Add or change a role's access")];
    if (roles.length) {
      rows.push(optionSelect(META, ACTIONS.revoke, "Remove a role's access", roles.map((role) => ({
        label: roleName(role.roleId),
        description: `Currently ${permissionLabel(role.level)}`,
        value: role.roleId,
      }))));
    }
    return configPage(META, {
      fields: [...ASSIGNABLE_LEVELS].reverse().map((level) => {
        const members = roles.filter((role) => role.level === level);
        return note(
          `${permissionLabel(level)} — ${members.length} ${members.length === 1 ? "role" : "roles"}`,
          members.length ? members.map(({ roleId }) => `<@&${roleId}>`).join(" ") : "_No roles_",
        );
      }),
      rows,
    });
  }

  async function levelView(roleId: string): Promise<ConfigView> {
    const current = await db.permissionRole.findUnique({ where: { roleId } });
    return configPage(META, {
      summary: `Choose the access level for <@&${roleId}>.`,
      fields: [field("Current access", current ? permissionLabel(current.level) : "None")],
      rows: [configRow(
        ...ASSIGNABLE_LEVELS.map((level) => actionButton(META, `${ACTIONS.level}:${roleId}:${level}`, permissionLabel(level), {
          style: level === PermissionLevel.MANAGER ? ButtonStyle.Success : level === PermissionLevel.ADMIN ? ButtonStyle.Primary : ButtonStyle.Secondary,
          disabled: current?.level === level,
        })),
        actionButton(META, `${ACTIONS.level}:${roleId}:remove`, "Remove", { style: ButtonStyle.Danger, disabled: !current }),
        backButton(META, ACTIONS.back),
      )],
    });
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (action === ACTIONS.role && interaction.isRoleSelectMenu()) {
      return levelView(selectedValue(interaction, "Choose a role"));
    }
    if (action === ACTIONS.revoke && interaction.isStringSelectMenu()) {
      await db.permissionRole.deleteMany({ where: { roleId: selectedValue(interaction, "Choose a role") } });
      return null;
    }
    const selection = parsePermissionAction(action);
    if (selection) {
      const { roleId, choice } = selection;
      if (choice === "remove") {
        await db.permissionRole.deleteMany({ where: { roleId } });
        return null;
      }
      const level = Number(choice);
      if (!ASSIGNABLE_LEVELS.includes(level as (typeof ASSIGNABLE_LEVELS)[number])) userError("Invalid permission level");
      await db.permissionRole.upsert({ where: { roleId }, create: { roleId, level }, update: { level } });
      return null;
    }
    return null;
  }

  return { ...META, view, apply };
}
