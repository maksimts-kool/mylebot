import type { BotContext, BotFeature } from "../../core/feature.js";
import type { ConfigSection } from "../../shared/discord/config-section.js";
import { PermissionLevel } from "../../shared/permissions.js";
import { configCommandData } from "./discord/definitions.js";
import { ConfigPanelHandler } from "./discord/panel.js";
import { permissionsSection } from "./sections/permissions.js";

/**
 * The single settings surface. It owns the one page that belongs to no feature
 * — role permissions — and shows the pages features contribute through
 * `BotFeature.configSections`, which `src/bot.ts` collects in composition
 * order. Role permissions come last. Every setting is stored by the server
 * half; this feature has no half of its own there.
 */
export function createConfigBot(ctx: BotContext, sections: ConfigSection[]): BotFeature {
  const pages = [
    ...sections,
    permissionsSection(ctx.shared, ctx.client, ctx.config.DISCORD_GUILD_ID),
  ];
  new ConfigPanelHandler(ctx.client, ctx.shared, ctx.config, pages).register();

  return {
    name: "config",
    commands: configCommandData,
    help: {
      title: "Configuration",
      emoji: "⚙️",
      commands: [
        { usage: "/config", description: "Opens the server configuration panel: session tracking, role permissions, and every other feature's settings.", permission: PermissionLevel.MANAGER },
      ],
    },
  };
}
