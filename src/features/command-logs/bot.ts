import type { BotContext, BotFeature } from "../../core/feature.js";
import { commandLogsConfigSection } from "./discord/config-section.js";
import { registerCommandLogInteractions } from "./discord/interactions.js";
import { commandLogsBotPort } from "./discord/panel-messenger.js";
import { COMMAND_LOGS_PORT, type CommandLogsServerPort } from "./link.js";

/**
 * The command log's Discord surface: the server panels and their threads, the
 * presses on those panels, and the feature's page in `/config`.
 */
export function createCommandLogsBot(ctx: BotContext): BotFeature {
  const logs = ctx.server.port<CommandLogsServerPort>(COMMAND_LOGS_PORT);
  registerCommandLogInteractions(ctx.client, logs, ctx.log);
  return {
    name: "command-logs",
    configSections: [commandLogsConfigSection(logs)],
    ports: { [COMMAND_LOGS_PORT]: commandLogsBotPort(ctx.client, ctx.log) },
  };
}
