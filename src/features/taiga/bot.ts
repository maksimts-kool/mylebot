import type { BotContext, BotFeature } from "../../core/feature.js";
import { taigaConfigSection } from "./discord/config-section.js";
import { registerForumListener } from "./discord/forum-listener.js";
import { taigaBotPort } from "./discord/forum-port.js";
import { TAIGA_PORT, type TaigaServerPort } from "./link.js";

/**
 * The Taiga integration's Discord surface: the forum listener, the hands that
 * retag posts and narrate the board, and the page in `/config`. Composed only
 * when the server half says it runs the integration.
 */
export function createTaigaBot(ctx: BotContext): BotFeature | null {
  if (!ctx.capabilities.taiga) return null;
  const taiga = ctx.server.port<TaigaServerPort>(TAIGA_PORT);
  registerForumListener(ctx.client, taiga, ctx.log);
  return {
    name: "taiga",
    configSections: [taigaConfigSection(ctx.client, taiga)],
    ports: { [TAIGA_PORT]: taigaBotPort(ctx.client, ctx.log) },
  };
}
