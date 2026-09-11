import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { errorType } from "./errors.js";
import { secretMatches } from "./http.js";
import type { Logger } from "./logger.js";

/**
 * Splitting the application in two leaves one problem: some work can only
 * happen where the Discord gateway is. This module is the whole of the answer.
 *
 * Requests that need Discord are forwarded from the `server` container to the
 * `bot` container byte for byte, so the endpoint that finally answers them sees
 * exactly what the caller sent — which matters, because the Taiga webhook signs
 * its raw body. Going the other way, the server tells the bot which sessions
 * changed so Discord updates immediately instead of on the bot's next poll.
 *
 * Neither hop is load-bearing for correctness: the bot re-reads its own state
 * on a timer, so a missed notification costs latency, not accuracy.
 */

/** Headers that describe this connection rather than the request. */
const CONNECTION_HEADERS = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "proxy-authorization",
]);

const FORWARD_TIMEOUT_MS = 15_000;
const NOTIFY_TIMEOUT_MS = 5_000;

/** The path the bot answers refresh notifications on. */
export const SESSIONS_CHANGED_PATH = "/internal/bot/sessions/changed";

export type DiscordMessageReference = { channelId: string; messageId: string };

export interface BotLink {
  /** Asks the bot to bring these sessions' messages up to date, and take those down. */
  sessionsChanged(ids: string[], removedMessages?: DiscordMessageReference[]): Promise<void>;
}

const sessionsChangedSchema = z.object({
  ids: z.array(z.string()).max(500).default([]),
  removedMessages: z.array(z.object({ channelId: z.string(), messageId: z.string() })).max(500).default([]),
});

/**
 * The server half's handle on the bot half, or `null` when Discord is in this
 * same process and a feature should just do the work itself.
 */
export function createBotLink(config: Config, parentLog: Logger): BotLink | null {
  if (config.APP_ROLE !== "server" || !config.BOT_INTERNAL_URL) return null;
  const log = parentLog.child({ category: "http" });
  return {
    async sessionsChanged(ids, removedMessages = []) {
      if (!ids.length && !removedMessages.length) return;
      try {
        const response = await fetch(`${config.BOT_INTERNAL_URL}${SESSIONS_CHANGED_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.INTERNAL_SECRET}` },
          body: JSON.stringify({ ids, removedMessages }),
          signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
        });
        if (!response.ok) log.warn({ status: response.status }, "The bot turned down a session refresh");
      } catch (error) {
        // The bot's own refresh job picks these up regardless, so a failed
        // notification delays Discord rather than losing anything.
        log.warn({ err: error, errorType: errorType(error), sessions: ids.length }, "Could not reach the bot to refresh sessions");
      }
    },
  };
}

export type BotInternalRouteOptions = {
  config: Config;
  onSessionsChanged: (ids: string[], removedMessages: DiscordMessageReference[]) => Promise<void>;
};

/** The endpoints only the server container calls. Registered by the bot half. */
export function botInternalRoutes({ config, onSessionsChanged }: BotInternalRouteOptions): FastifyPluginAsync {
  return async (app) => {
    app.post(SESSIONS_CHANGED_PATH, async (request, reply) => {
      // An empty secret would make the comparison below pass for everyone.
      if (!config.INTERNAL_SECRET) return reply.code(503).send({ error: "internal_api_disabled" });
      if (!secretMatches(request.headers.authorization, config.INTERNAL_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      const { ids, removedMessages } = sessionsChangedSchema.parse(request.body);
      await onSessionsChanged(ids, removedMessages);
      return reply.code(202).send({ status: "accepted" });
    });
  };
}

export type GatewayProxyOptions = {
  config: Config;
  /** Route patterns to hand over, e.g. `/internal/*`. */
  patterns: string[];
  log: Logger;
};

/**
 * Passes the Discord-dependent routes through to the bot container unchanged.
 * The body stays a buffer and the caller's headers are forwarded as they
 * arrived, so signature checks and bearer tokens are verified once, at the end
 * of the line, by the same code that would have verified them unsplit.
 */
export function gatewayProxy({ config, patterns, log }: GatewayProxyOptions): FastifyPluginAsync {
  return async (app) => {
    // Nothing here may re-encode a body: the Taiga webhook's signature covers
    // the exact bytes it sent. Fastify's built-in JSON parser would hand us an
    // object, so this scope drops every parser and keeps the buffer. Parsers
    // are encapsulated, so routes the server answers itself still get objects.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });

    const forward = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (CONNECTION_HEADERS.has(name) || value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD" && Buffer.isBuffer(request.body);
      try {
        const response = await fetch(`${config.BOT_INTERNAL_URL}${request.url}`, {
          method: request.method,
          headers,
          ...(hasBody ? { body: request.body as Buffer } : {}),
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        const contentType = response.headers.get("content-type");
        if (contentType) reply.header("content-type", contentType);
        return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        log.error({ category: "http", err: error, errorType: errorType(error) }, `The bot container did not answer ${request.url}`);
        return reply.code(503).send({ error: "bot_unavailable" });
      }
    };

    for (const pattern of patterns) app.all(pattern, forward);
  };
}
