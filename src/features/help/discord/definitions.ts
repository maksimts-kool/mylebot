import { SlashCommandBuilder } from "discord.js";

export const helpCommandData = [
  new SlashCommandBuilder().setName("help").setDescription("List every command this bot answers"),
].map((command) => command.toJSON());
