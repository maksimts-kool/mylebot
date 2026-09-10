import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  type Client, type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Db } from "../../../core/db.js";
import { userError } from "../../../core/errors.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import { configCustomId, type ConfigComponentInteraction, type ConfigRow, type ConfigSection, type ConfigView } from "../../../shared/discord/config-section.js";
import { PermissionLevel, permissionLabel } from "../../../shared/permissions.js";

const ID = "permissions";

/** Discord allows 25 options in a select menu. */
const REMOVABLE_LIMIT = 25;

const ASSIGNABLE_LEVELS = [PermissionLevel.STAFF, PermissionLevel.ADMIN, PermissionLevel.MANAGER] as const;

const LEVEL_SUMMARY: Record<number, string> = {
  [PermissionLevel.STAFF]: "Sees session histories and live sessions.",
  [PermissionLevel.ADMIN]: "Everything staff can do, plus adding, editing and removing sessions.",
  [PermissionLevel.MANAGER]: "Everything admins can do, plus this configuration panel.",
};

/**
 * Splits `permissions:level:<roleId>:<choice>` into its parts. Exported so the
 * custom id format stays covered by a test.
 */
export function parsePermissionAction(action: string): { roleId: string; choice: string } | null {
  const prefix = "level:";
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
    const byLevel = [...ASSIGNABLE_LEVELS].reverse().map((level) => {
      const members = roles.filter((role) => role.level === level);
      return {
        name: `${permissionLabel(level)} — ${members.length} ${members.length === 1 ? "role" : "roles"}`,
        value: members.length
          ? members.map(({ roleId }) => `<@&${roleId}>`).join(" ")
          : "_No roles_",
        inline: false,
      };
    });
    const embed = new EmbedBuilder()
      .setTitle("🔑 Role permissions")
      .setDescription([
        "Access is cumulative: a member gets the highest level of any role they hold, and anyone with Discord's Administrator permission always counts as a manager.",
        "",
        ...ASSIGNABLE_LEVELS.map((level) => `**${permissionLabel(level)}** — ${LEVEL_SUMMARY[level]}`),
      ].join("\n"))
      .setColor(BRAND_COLOR)
      .addFields(byLevel);

    const components: ConfigRow[] = [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new RoleSelectMenuBuilder().setCustomId(configCustomId(ID, "role")).setPlaceholder("Add or change a role's access"),
      ),
    ];
    if (roles.length) {
      components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(configCustomId(ID, "revoke"))
          .setPlaceholder("Remove a role's access")
          .addOptions(roles.slice(0, REMOVABLE_LIMIT).map((role) => ({
            label: roleName(role.roleId).slice(0, 100),
            description: `Currently ${permissionLabel(role.level)}`,
            value: role.roleId,
          }))),
      ));
    }
    return { embeds: [embed], components };
  }

  async function levelView(roleId: string): Promise<ConfigView> {
    const current = await db.permissionRole.findUnique({ where: { roleId } });
    const embed = new EmbedBuilder()
      .setTitle("🔑 Role permissions")
      .setDescription(`Choose the access level for <@&${roleId}>.`)
      .setColor(BRAND_COLOR)
      .addFields(
        { name: "Current access", value: current ? permissionLabel(current.level) : "None", inline: true },
        ...ASSIGNABLE_LEVELS.map((level) => ({ name: permissionLabel(level), value: LEVEL_SUMMARY[level] ?? "", inline: false })),
      );
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      ...ASSIGNABLE_LEVELS.map((level) => new ButtonBuilder()
        .setCustomId(configCustomId(ID, `level:${roleId}:${level}`))
        .setLabel(permissionLabel(level))
        .setStyle(level === PermissionLevel.MANAGER ? ButtonStyle.Success : level === PermissionLevel.ADMIN ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(current?.level === level)),
      new ButtonBuilder()
        .setCustomId(configCustomId(ID, `level:${roleId}:remove`))
        .setLabel("Remove")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!current),
      new ButtonBuilder().setCustomId(configCustomId(ID, "back")).setLabel("Back").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (action === "role" && interaction.isRoleSelectMenu()) {
      const roleId = interaction.values[0];
      if (!roleId) userError("Choose a role");
      return levelView(roleId);
    }
    if (action === "revoke" && interaction.isStringSelectMenu()) {
      const roleId = interaction.values[0];
      if (!roleId) userError("Choose a role");
      await db.permissionRole.deleteMany({ where: { roleId } });
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

  return {
    id: ID,
    label: "Role permissions",
    emoji: "🔑",
    description: "Grant, change, and revoke staff, admin, and manager access per role.",
    view,
    apply,
  };
}
