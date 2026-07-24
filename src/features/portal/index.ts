import type { Feature, FeatureContext } from "../../core/feature.js";
import { portalRoutes } from "./api/routes.js";
import { createDirectMessageSender } from "./service/direct-message.js";
import { VerifiedMemberDirectory } from "./service/verified-members.js";

/**
 * The store-owners portal: authenticated internal endpoints the website uses to
 * reach Discord through the bot's existing gateway connection.
 */
export function createPortalFeature(ctx: FeatureContext): Feature {
  const directory = new VerifiedMemberDirectory(ctx.client, ctx.config);
  return {
    name: "portal",
    routes: portalRoutes({
      config: ctx.config,
      sendDirectMessage: createDirectMessageSender(ctx.client),
      resolveRobloxUsername: async (discordId) => (await ctx.bloxlink.robloxForDiscord(discordId))?.username ?? null,
      listVerifiedGuildMembers: () => directory.list(),
    }),
  };
}
