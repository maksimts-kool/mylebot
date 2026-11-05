import type { ServerContext, ServerFeature } from "../../core/feature.js";
import { LinkUnavailableError } from "../../core/link.js";
import { portalRoutes } from "./api/routes.js";
import { PORTAL_PORT, type PortalBotPort } from "./link.js";

/**
 * The store-owners portal: authenticated internal endpoints the website calls.
 * They are answered here; the DMs and the member list come from the bot half.
 */
export function createPortalServer(ctx: ServerContext): ServerFeature {
  const discord = ctx.bot.port<PortalBotPort>(PORTAL_PORT);
  return {
    name: "portal",
    routes: portalRoutes({
      config: ctx.config,
      sendDirectMessage: async (input) => {
        try {
          return await discord.sendDirectMessage(input);
        } catch (error) {
          if (error instanceof LinkUnavailableError) return { ok: false, status: 503, error: "discord_not_ready" };
          throw error;
        }
      },
      resolveRobloxUsername: async (discordId) => (await ctx.bloxlink.robloxForDiscord(discordId))?.username ?? null,
      // Discord being away answers an empty list, as it always has.
      listVerifiedGuildMembers: () => discord.listVerifiedMembers().catch((error: unknown) => {
        if (error instanceof LinkUnavailableError) return [];
        throw error;
      }),
    }),
  };
}
