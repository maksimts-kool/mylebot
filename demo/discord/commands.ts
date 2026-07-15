import { SlashCommandBuilder } from "discord.js";
import { RANK_CODES, RANKS } from "../domain/ranks.js";

const rankChoices = RANK_CODES.map((code) => ({ name: `${code} — ${RANKS[code].label}`, value: code }));

// Demo command set. Namespaced so it never collides with the production bot's
// /session, /leaderboard, /config commands (the demo runs as its own application).
export const commandData = [
  new SlashCommandBuilder()
    .setName("apply")
    .setDescription("Apply to join the lift staff team")
    .addStringOption((o) => o.setName("track").setDescription("Which team you are applying for").setRequired(true)
      .addChoices({ name: "Surfer (cartop) → Lift Surfer", value: "SURFER" }, { name: "Engineer (cabinet) → Lift Engineer", value: "ENGINEER" })),

  new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Staff hiring and rank management")
    .addSubcommand((s) => s.setName("view").setDescription("View a member's staff rank and hire info")
      .addUserOption((o) => o.setName("user").setDescription("Member (defaults to you)").setRequired(false)))
    .addSubcommand((s) => s.setName("roster").setDescription("List current staff grouped by rank"))
    .addSubcommand((s) => s.setName("assign").setDescription("Directly place a user at a rank (creates the staff record if needed)")
      .addUserOption((o) => o.setName("user").setDescription("Member to assign").setRequired(true))
      .addStringOption((o) => o.setName("rank").setDescription("Rank to assign").setRequired(true).addChoices(...rankChoices)))
    .addSubcommand((s) => s.setName("promote").setDescription("Promote a staff member")
      .addUserOption((o) => o.setName("user").setDescription("Member to promote").setRequired(true))
      .addStringOption((o) => o.setName("rank").setDescription("New rank").setRequired(true).addChoices(...rankChoices)))
    .addSubcommand((s) => s.setName("demote").setDescription("Demote a staff member")
      .addUserOption((o) => o.setName("user").setDescription("Member to demote").setRequired(true))
      .addStringOption((o) => o.setName("rank").setDescription("New rank").setRequired(true).addChoices(...rankChoices)))
    .addSubcommand((s) => s.setName("config").setDescription("Configure channels and rank → role mappings (managers)"))
    .addSubcommand((s) => s.setName("questions").setDescription("Edit the application questionnaire (managers)")),
].map((command) => command.toJSON());
