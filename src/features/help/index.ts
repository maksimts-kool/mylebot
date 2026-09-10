import type { Feature, FeatureContext } from "../../core/feature.js";
import type { HelpSection } from "../../shared/discord/help.js";
import { PermissionLevel } from "../../shared/permissions.js";
import { helpCommandData } from "./discord/definitions.js";
import { HelpCommandHandler } from "./discord/handler.js";

/**
 * `/help`. The sections come from the features `src/index.ts` composed, plus
 * this feature's own entry, so the listing always matches the deployed command
 * set.
 */
export function createHelpFeature(ctx: FeatureContext, sections: HelpSection[]): Feature {
  const help: HelpSection = {
    title: "Help",
    emoji: "📖",
    commands: [
      { usage: "/help", description: "Shows this list of commands.", permission: PermissionLevel.EVERYONE },
    ],
  };
  new HelpCommandHandler(ctx.client, ctx.db, ctx.config, [...sections, help]).register();

  return { name: "help", commands: helpCommandData, help };
}
