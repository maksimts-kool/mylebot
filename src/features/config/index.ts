import type { Feature, FeatureContext } from "../../core/feature.js";
import type { ConfigSection } from "../../shared/discord/config-section.js";
import { PermissionLevel } from "../../shared/permissions.js";
import { configCommandData } from "./discord/definitions.js";
import { ConfigPanelHandler } from "./discord/panel.js";
import { permissionsSection } from "./sections/permissions.js";

/**
 * The single settings surface. It owns the one page that belongs to no feature
 * — role permissions — and shows the pages features contribute through
 * `Feature.configSections`, which `src/index.ts` collects in composition order.
 * Role permissions come last.
 */
export function createConfigFeature(ctx: FeatureContext, sections: ConfigSection[]): Feature {
  const pages = [
    ...sections,
    permissionsSection(ctx.db, ctx.client, ctx.config.DISCORD_GUILD_ID),
  ];
  new ConfigPanelHandler(ctx.client, ctx.db, ctx.config, pages).register();

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
