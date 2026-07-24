import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  RoleSelectMenuBuilder, type ButtonInteraction, type ChannelSelectMenuInteraction, type RoleSelectMenuInteraction,
} from "discord.js";
import { userError } from "../../../../core/errors.js";
import { PermissionLevel, permissionLabel } from "../../../../shared/permissions.js";
import type { SessionCommandContext } from "./context.js";
import { parsePermissionRoleChoice } from "./definitions.js";

export async function configPanel(ctx: SessionCommandContext) {
  const settings = await ctx.settings.get();
  const permissions = await ctx.db.permissionRole.findMany({ orderBy: { level: "desc" } });
  const roles = permissions.length
    ? permissions.map(({ roleId, level }) => `<@&${roleId}> — ${permissionLabel(level)}`).join("\n")
    : "No role permissions configured.";
  const embed = new EmbedBuilder()
    .setTitle("⚙️ Session tracking configuration")
    .setDescription("Use the controls below to change settings. This panel is only visible to you.")
    .addFields(
      { name: "Tracking", value: settings.trackingEnabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
      { name: "Logs channel", value: settings.logsChannelId ? `<#${settings.logsChannelId}>` : "Not configured", inline: true },
      { name: "Role permissions", value: roles },
    );
  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder().setCustomId("config-logs").setPlaceholder("Choose the session logs channel").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const roleRow = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder().setCustomId("config-role").setPlaceholder("Choose a role to configure"),
  );
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`config-tracking:${settings.trackingEnabled ? "off" : "on"}`).setStyle(settings.trackingEnabled ? ButtonStyle.Danger : ButtonStyle.Success).setLabel(settings.trackingEnabled ? "Disable tracking" : "Enable tracking"),
    new ButtonBuilder().setCustomId("cancel").setStyle(ButtonStyle.Secondary).setLabel("Close").setEmoji("✖️"),
  );
  return { embeds: [embed], components: [channelRow, roleRow, buttonRow] };
}

export async function toggleTracking(ctx: SessionCommandContext, interaction: ButtonInteraction): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.MANAGER);
  await ctx.settings.setTrackingEnabled(interaction.customId.endsWith(":on"));
  await interaction.update(await configPanel(ctx));
}

export async function applyRoleLevel(ctx: SessionCommandContext, interaction: ButtonInteraction): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.MANAGER);
  const selection = parsePermissionRoleChoice(interaction.customId);
  if (!selection) userError("Role or permission level not found");
  const { roleId, choice } = selection;
  if (choice === "remove") {
    await ctx.db.permissionRole.deleteMany({ where: { roleId } });
    await interaction.update(await configPanel(ctx));
    return;
  }
  const level = Number(choice);
  if (![PermissionLevel.STAFF, PermissionLevel.ADMIN, PermissionLevel.MANAGER].includes(level as 2 | 3 | 4)) userError("Invalid permission level");
  await ctx.db.permissionRole.upsert({ where: { roleId }, create: { roleId, level }, update: { level } });
  await interaction.update(await configPanel(ctx));
}

export async function selectLogsChannel(ctx: SessionCommandContext, interaction: ChannelSelectMenuInteraction): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.MANAGER);
  const channel = interaction.channels.first();
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) userError("Choose a text channel for session logs");
  await ctx.settings.setLogsChannel(channel.id);
  await interaction.update(await configPanel(ctx));
}

export async function selectPermissionRole(ctx: SessionCommandContext, interaction: RoleSelectMenuInteraction): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.MANAGER);
  const roleId = interaction.values[0];
  if (!roleId) userError("Choose a role");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`config-role-level:${roleId}:${PermissionLevel.STAFF}`).setLabel("Staff").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`config-role-level:${roleId}:${PermissionLevel.ADMIN}`).setLabel("Admin").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`config-role-level:${roleId}:${PermissionLevel.MANAGER}`).setLabel("Manager").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`config-role-level:${roleId}:remove`).setLabel("Remove").setStyle(ButtonStyle.Danger),
  );
  await interaction.update({ content: `Choose the permission level for <@&${roleId}>:`, embeds: [], components: [row] });
}
