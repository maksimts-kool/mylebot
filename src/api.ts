import { timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { presenceBatchSchema } from "./domain/events.js";
import type { DiscordMessageReference, SessionService } from "./services/session-service.js";

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

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function secretMatches(header: string | undefined, expected: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function buildApi(
  config: Config,
  sessions: SessionService,
  onChanged: (ids: string[], removedMessages?: DiscordMessageReference[]) => Promise<void>,
  readiness: () => Promise<void> = async () => undefined,
  sendDirectMessage: SendDirectMessage = async () => ({ ok: false, status: 503, error: "not_configured" }),
  resolveRobloxUsername: ResolveRobloxUsername = async () => null,
  listVerifiedGuildMembers: ListVerifiedGuildMembers = async () => [],
) {
  const app = Fastify({
    logger: {
      level: "info",
      redact: {
        paths: ["req.headers", "res.headers['set-cookie']"],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 256 * 1024,
    trustProxy: config.TRUST_PROXY === "loopback" ? "127.0.0.1/8" : false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await readiness();
      return { status: "ready" };
    } catch (error) {
      app.log.error({ operation: "readiness_check", errorType: errorType(error) }, "Readiness check failed");
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.post("/v1/roblox/presence/batch", async (request, reply) => {
    if (!secretMatches(request.headers.authorization, config.ROBLOX_INGESTION_SECRET)) {
      return reply.code(401).send({ error: "invalid_authentication" });
    }
    const batch = presenceBatchSchema.parse(request.body);
    if (batch.events.length > config.MAX_BATCH_SIZE) return reply.code(413).send({ error: "batch_too_large" });
    const results = [];
    const changed = new Set<string>();
    const removedMessages: DiscordMessageReference[] = [];
    for (const event of batch.events) {
      const result = await sessions.process(event);
      results.push(result);
      if (result.changed && result.sessionId) changed.add(result.sessionId);
      if (result.alsoChangedSessionId) changed.add(result.alsoChangedSessionId);
      if (result.removedMessages) removedMessages.push(...result.removedMessages);
    }
    if (removedMessages.length) await onChanged([...changed], removedMessages);
    else await onChanged([...changed]);
    const outcomes = results.reduce<Record<string, number>>((counts, result) => {
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      return counts;
    }, {});
    app.log.info({ eventCount: batch.events.length, changedSessionCount: changed.size, removedMessageCount: removedMessages.length, outcomes }, "Authenticated presence batch completed");
    return reply.code(202).send({ results });
  });

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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "invalid_payload", details: error.flatten() });
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("universe") || message.includes("place") || message.includes("rank") || message.includes("timestamp")) {
      return reply.code(400).send({ error: "rejected_event", message });
    }
    app.log.error({ operation: "request_handling", errorType: errorType(error) }, "Unhandled request error");
    return reply.code(500).send({ error: "internal_error" });
  });
  return app;
}
