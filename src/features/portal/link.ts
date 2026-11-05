import type { DirectMessageInput, DirectMessageResult, VerifiedGuildMember } from "./api/routes.js";

/**
 * The contract between the two halves of the store-owners portal. The server
 * half answers the website and resolves Roblox names through Bloxlink; the bot
 * half sends the DMs and reads the guild's members.
 */

export const PORTAL_PORT = "portal";

/** What the server half asks of Discord for the portal. */
export interface PortalBotPort {
  sendDirectMessage(input: DirectMessageInput): Promise<DirectMessageResult>;
  listVerifiedMembers(): Promise<VerifiedGuildMember[]>;
}
