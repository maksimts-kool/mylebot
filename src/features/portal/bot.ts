import type { BotContext, BotFeature } from "../../core/feature.js";
import { PORTAL_PORT, type PortalBotPort } from "./link.js";
import { createDirectMessageSender } from "./discord/direct-message.js";
import { VerifiedMemberDirectory } from "./discord/verified-members.js";

/** The portal's Discord hands: DMs on the website's behalf, and the guild's verified members. */
export function createPortalBot(ctx: BotContext): BotFeature {
  const directory = new VerifiedMemberDirectory(ctx.client, ctx.config);
  const send = createDirectMessageSender(ctx.client);
  const port: PortalBotPort = {
    sendDirectMessage: (input) => send(input),
    listVerifiedMembers: () => directory.list(),
  };
  return { name: "portal", ports: { [PORTAL_PORT]: port } };
}
