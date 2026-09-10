import type { Feature, FeatureContext } from "../../core/feature.js";
import type { ConfigSection } from "../../shared/discord/config-section.js";
import { PermissionLevel } from "../../shared/permissions.js";
import { configCommandData } from "./discord/definitions.js";
import { ConfigPanelHandler } from "./discord/panel.js";
import { permissionsSection } from "./sections/permissions.js";
import { trackingSection } from "./sections/tracking.js";

/**
 * The single settings surface. It owns the pages that belong to no one feature
 * — session tracking and role permissions — and shows the pages other features
 * contribute through `Feature.configSections`, which `src/index.ts` collects.
 * Extra sections are appended, so the built-in pages always come first.
 */
export function createConfigFeature(ctx: FeatureContext, sections: ConfigSection[]): Feature {
  const pages = [
    trackingSection(ctx.settings),
    permissionsSection(ctx.db, ctx.client, ctx.config.DISCORD_GUILD_ID),
    ...sections,
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
