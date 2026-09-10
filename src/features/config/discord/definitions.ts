import { SlashCommandBuilder } from "discord.js";

export const configCommandData = [
  new SlashCommandBuilder().setName("config").setDescription("Open the server configuration panel"),
].map((command) => command.toJSON());

/** Everything the panel answers for. Other features share this gateway event. */
export const CONFIG_CUSTOM_ID_PREFIX = "config:";
export const CONFIG_NAV_CUSTOM_ID = "config:nav";
export const CONFIG_HOME_VALUE = "home";
export const CONFIG_CLOSE_VALUE = "close";
