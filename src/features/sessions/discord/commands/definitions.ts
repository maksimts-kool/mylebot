import { SlashCommandBuilder } from "discord.js";
import { PermissionLevel } from "../../../../shared/permissions.js";
import type { HelpSection } from "../../../../shared/discord/help.js";

export const sessionCommandData = [
  new SlashCommandBuilder().setName("session").setDescription("Manage staff sessions")
    .addSubcommand((s) => s.setName("active").setDescription("🟢 Show every live session, or one member's")
      .addUserOption((o) => o.setName("user").setDescription("Discord user (omit for everyone on shift; other members need Admin)").setRequired(false)))
    .addSubcommand((s) => s.setName("view").setDescription("📚 View, and as an Admin manage, a user's session history")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show the staff leaderboard")
    .addStringOption((o) => o.setName("period").setDescription("Reporting period (defaults to this month)")
      .addChoices(
        { name: "This week", value: "week" },
        { name: "This month", value: "month" },
        { name: "This year", value: "year" },
      )),
  new SlashCommandBuilder().setName("profile").setDescription("Show a staff member's profile card and badges")
    .addUserOption((o) => o.setName("user").setDescription("Discord user (omit for yourself)").setRequired(false)),
  new SlashCommandBuilder().setName("badges").setDescription("See every badge, how to earn it, and your progress"),
].map((command) => command.toJSON());

export function requiredPermission(commandName: string, subcommand?: string): number {
  if (["leaderboard", "profile", "badges"].includes(commandName)) return PermissionLevel.EVERYONE;
  if (commandName === "session" && ["view", "active"].includes(subcommand ?? "")) return PermissionLevel.STAFF;
  return PermissionLevel.MANAGER;
}

/** Command names this feature owns, so its listener can ignore everything else. */
export const sessionCommandNames = new Set(["session", "leaderboard", "profile", "badges"]);

export const sessionHelp: HelpSection = {
  title: "Sessions",
  emoji: "🎮",
  commands: [
    { usage: "/leaderboard [period]", description: "Ranks staff by recorded time for this week, month, or year.", permission: PermissionLevel.EVERYONE },
    { usage: "/profile [user]", description: "Posts a member's profile card: shift stats, rank, and badges.", permission: PermissionLevel.EVERYONE },
    { usage: "/badges", description: "Lists every badge and how to earn it, with your own progress. Only you see it.", permission: PermissionLevel.EVERYONE },
    { usage: "/session active [user]", description: "Lists every session running right now. Name a member to see that session in full.", permission: PermissionLevel.STAFF },
    { usage: "/session view user", description: "Shows a member's session history. Admins also get controls there to add, edit, and remove completed sessions.", permission: PermissionLevel.STAFF },
  ],
};
