import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Config } from "../../../core/config.js";
import { secretMatches } from "../../../core/http.js";

// Payload for the store-owners site's DM notification endpoint.
const notifySchema = z.object({
  discordId: z.string().regex(/^\d{5,25}$/, "discordId must be a Discord snowflake"),
  title: z.string().min(1).max(256),
  message: z.string().min(1).max(2000),
  // When the message contains {{uploader}}, the bot resolves this Discord ID
  // through Bloxlink and substitutes the Roblox username (without rank).
  uploaderDiscordId: z.string().regex(/^\d{5,25}$/, "uploaderDiscordId must be a Discord snowflake").optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  url: z.string().url().optional(),
});

export type DirectMessageInput = z.infer<typeof notifySchema>;
export type DirectMessageResult = { ok: true } | { ok: false; status?: number; error?: string };
export type SendDirectMessage = (input: DirectMessageInput) => Promise<DirectMessageResult>;
export type ResolveRobloxUsername = (discordId: string) => Promise<string | null>;
export interface VerifiedGuildMember {
  discordId: string;
  discordName: string;
  robloxUsername: string | null;
}
export type ListVerifiedGuildMembers = () => Promise<VerifiedGuildMember[]>;

export type PortalRouteOptions = {
  config: Config;
  sendDirectMessage?: SendDirectMessage;
  resolveRobloxUsername?: ResolveRobloxUsername;
  listVerifiedGuildMembers?: ListVerifiedGuildMembers;
};

/**
 * The store-owners portal surface. Every route is gated on SITE_NOTIFY_SECRET,
 * and returns 503 rather than 401 when the integration is switched off entirely.
 */
export function portalRoutes({
  config,
  sendDirectMessage = async () => ({ ok: false, status: 503, error: "not_configured" }),
  resolveRobloxUsername = async () => null,
  listVerifiedGuildMembers = async () => [],
}: PortalRouteOptions): FastifyPluginAsync {
  return async (app) => {
    // Internal endpoint used by the store-owners site to DM a Discord user through
    // the bot's existing gateway connection. Authenticated with a shared secret.
    app.post("/internal/notify", async (request, reply) => {
      if (!config.SITE_NOTIFY_SECRET) return reply.code(503).send({ error: "notify_disabled" });
      if (!secretMatches(request.headers.authorization, config.SITE_NOTIFY_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      const input = notifySchema.parse(request.body);
      const uploaderName = input.uploaderDiscordId && input.message.includes("{{uploader}}")
        ? await resolveRobloxUsername(input.uploaderDiscordId)
        : null;
      const message = input.message.replaceAll("{{uploader}}", uploaderName ?? "A store owner");
      const result = await sendDirectMessage({ ...input, message });
      if (!result.ok) return reply.code(result.status ?? 502).send({ error: result.error ?? "dm_failed" });
      return reply.code(200).send({ status: "sent" });
    });

    // Internal lookup for the store-owners portal. The value is a Roblox username
    // only; rank and Discord account details are intentionally never returned.
    app.get<{ Params: { discordId: string } }>("/internal/roblox-username/:discordId", async (request, reply) => {
      if (!config.SITE_NOTIFY_SECRET) return reply.code(503).send({ error: "notify_disabled" });
      if (!secretMatches(request.headers.authorization, config.SITE_NOTIFY_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      const { discordId } = z.object({ discordId: z.string().regex(/^\d{5,25}$/) }).parse(request.params);
      const username = await resolveRobloxUsername(discordId);
      return reply.code(200).send({ username });
    });

    // Authenticated owner-picker data for the store-owners portal. The bot only
    // returns Bloxlink-verified members who currently belong to its own guild.
    app.get("/internal/verified-members", async (request, reply) => {
      if (!config.SITE_NOTIFY_SECRET) return reply.code(503).send({ error: "notify_disabled" });
      if (!secretMatches(request.headers.authorization, config.SITE_NOTIFY_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      return reply.code(200).send({ members: await listVerifiedGuildMembers() });
    });
  };
}
