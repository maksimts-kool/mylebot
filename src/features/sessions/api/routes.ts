import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import type { Config } from "../../../core/config.js";
import { describeRequest, replyWithDefaultError, secretMatches } from "../../../core/http.js";
import { presenceBatchSchema, summarizePresenceBatch } from "../domain/events.js";
import type { DiscordMessageReference, SessionService } from "../service/session-service.js";

/** Called after a batch so Discord can catch up with the new session state. */
export type SessionsChanged = (ids: string[], removedMessages?: DiscordMessageReference[]) => Promise<void>;

export type SessionRouteOptions = {
  config: Config;
  sessions: SessionService;
  onChanged: SessionsChanged;
};

export function sessionRoutes({ config, sessions, onChanged }: SessionRouteOptions): FastifyPluginAsync {
  return async (app) => {
    // A source-valid but rejected event (wrong universe/place/rank, stale clock)
    // is the caller's problem, not ours. Payload-shape errors are checked first
    // because a Zod message can mention the same field names.
    app.setErrorHandler((error, request, reply) => {
      if (!(error instanceof ZodError)) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message.includes("universe") || message.includes("place") || message.includes("rank") || message.includes("timestamp")) {
          describeRequest(request, { did: `rejected: ${message}` });
          return reply.code(400).send({ error: "rejected_event", message });
        }
      }
      return replyWithDefaultError(app.log, error, reply);
    });

    app.post("/v1/roblox/presence/batch", async (request, reply) => {
      if (!secretMatches(request.headers.authorization, config.ROBLOX_INGESTION_SECRET)) {
        describeRequest(request, { did: "wrong ingestion secret" });
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
        if (result.removedMessages) removedMessages.push(...result.removedMessages);
      }
      if (removedMessages.length) await onChanged([...changed], removedMessages);
      else await onChanged([...changed]);
      // What a batch actually did to a shift is logged by the session lifecycle,
      // one line per real change, so this line is the summary underneath.
      describeRequest(request, summarizePresenceBatch(
        batch.events.map(({ kind }) => kind),
        results.map(({ status }) => status),
        changed.size,
      ));
      return reply.code(202).send({ results });
    });
  };
}
