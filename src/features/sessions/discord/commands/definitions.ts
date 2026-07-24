import { SlashCommandBuilder } from "discord.js";
import { PermissionLevel } from "../../../../shared/permissions.js";

export const sessionCommandData = [
  new SlashCommandBuilder().setName("session").setDescription("Manage staff sessions")
    .addSubcommand((s) => s.setName("active").setDescription("🟢 Show a live session")
      .addUserOption((o) => o.setName("user").setDescription("Discord user (defaults to you; other members need Admin)").setRequired(false)))
    .addSubcommand((s) => s.setName("view").setDescription("📚 View a user's session history")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true)))
    .addSubcommand((s) => s.setName("manage").setDescription("🛠️ Manage a completed session")
      .addStringOption((o) => o.setName("sessionid").setDescription("Completed session ID").setRequired(true)))
    .addSubcommand((s) => s.setName("add").setDescription("➕ Add a completed session")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show the staff leaderboard")
    .addStringOption((o) => o.setName("period").setDescription("Reporting period (defaults to this month)")
      .addChoices(
        { name: "This week", value: "week" },
        { name: "This month", value: "month" },
        { name: "This year", value: "year" },
        { name: "All time", value: "all" },
      )),
  new SlashCommandBuilder().setName("config").setDescription("Open the session tracking configuration panel"),
].map((command) => command.toJSON());

export function requiredPermission(commandName: string, subcommand?: string): number {
  if (commandName === "leaderboard") return PermissionLevel.EVERYONE;
  if (commandName === "config") return PermissionLevel.MANAGER;
  if (commandName === "session" && ["view", "active"].includes(subcommand ?? "")) return PermissionLevel.STAFF;
  if (commandName === "session" && ["add", "manage"].includes(subcommand ?? "")) return PermissionLevel.ADMIN;
  return PermissionLevel.MANAGER;
}

export function parsePermissionRoleChoice(customId: string): { roleId: string; choice: string } | null {
  const prefix = "config-role-level:";
  if (!customId.startsWith(prefix)) return null;
  const [roleId, choice] = customId.slice(prefix.length).split(":");
  return roleId && choice ? { roleId, choice } : null;
}

/** Command names this feature owns, so its listener can ignore everything else. */
export const sessionCommandNames = new Set(["session", "leaderboard", "config"]);
