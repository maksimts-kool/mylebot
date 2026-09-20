import type { FastifyPluginAsync } from "fastify";
import type { CommandLogEntry } from "@prisma/client";
import { ZodError } from "zod";
import type { Config } from "../../../core/config.js";
import { replyWithDefaultError, secretMatches } from "../../../core/http.js";
import { commandBatchSchema } from "../domain/events.js";
import { rosterSchema } from "../domain/roster.js";
import type { ServerRoster } from "../domain/roster.js";
import type { CommandLogService } from "../service/command-log-service.js";

/** Called once a batch has been stored, so Discord can post what is new. */
export type CommandRunsRecorded = (entries: CommandLogEntry[]) => Promise<void>;

/** Called for a roster the feature is willing to show. */
export type ServerReported = (roster: ServerRoster) => Promise<void>;

export type CommandRunRouteOptions = {
  config: Config;
  service: CommandLogService;
  onRecorded: CommandRunsRecorded;
  onReported: ServerReported;
};

export type CommandBlockRouteOptions = {
  config: Config;
  service: CommandLogService;
};

/**
 * Where the Adonis plugin reports command runs. Posting them needs the Discord
 * gateway, so this half only runs where the gateway is.
 */
export function commandRunRoutes({ config, service, onRecorded, onReported }: CommandRunRouteOptions): FastifyPluginAsync {
  return async (app) => {
    // A batch from the wrong universe or place is the caller's problem, not a
    // server fault. Payload-shape errors are checked first, as they do for
    // presence ingestion, because a Zod message names the same fields.
    app.setErrorHandler((error, _request, reply) => {
      if (!(error instanceof ZodError)) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message.includes("universe") || message.includes("place")) {
          return reply.code(400).send({ error: "rejected_event", message });
        }
      }
      return replyWithDefaultError(app.log, error, reply);
    });

    app.post("/v1/roblox/commands/batch", async (request, reply) => {
      if (!secretMatches(request.headers.authorization, config.ROBLOX_INGESTION_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      const batch = commandBatchSchema.parse(request.body);
      if (batch.events.length > config.MAX_BATCH_SIZE) return reply.code(413).send({ error: "batch_too_large" });

      const results = [];
      const recorded: CommandLogEntry[] = [];
      for (const event of batch.events) {
        const result = await service.record(event);
        if (result.status === "recorded") recorded.push(result.entry);
        results.push({
          eventId: event.eventId,
          status: result.status,
          ...(result.status === "skipped" ? { reason: result.reason } : {}),
        });
      }
      // Posting is the slow part and the plugin does not need to wait for it,
      // but a failure must not be hidden either: `postMany` logs per entry.
      if (recorded.length) await onRecorded(recorded);
      app.log.debug({ category: "command", events: batch.events.length, posted: recorded.length }, "Command batch accepted");
      return reply.code(202).send({ results });
    });

    // Who is in a server right now. This arrives on a timer and whenever staff
    // come and go, and it is what the server's panel is drawn from.
    app.post("/v1/roblox/commands/roster", async (request, reply) => {
      if (!secretMatches(request.headers.authorization, config.ROBLOX_INGESTION_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      const roster = rosterSchema.parse(request.body);
      const shown = await service.rosterAllowed(roster);
      if (shown) await onReported(roster);
      app.log.debug({ category: "command", jobId: roster.jobId, staff: roster.staff.length }, "Server roster accepted");
      return reply.code(202).send({ status: shown ? "shown" : "ignored" });
    });
  };
}

/**
 * The list the plugin polls to learn who currently has no command access.
 * Reading it needs nothing but the database, so it stays in the API half and
 * keeps working while Discord is down.
 */
export function commandBlockRoutes({ config, service }: CommandBlockRouteOptions): FastifyPluginAsync {
  return async (app) => {
    app.get("/v1/roblox/command-blocks", async (request, reply) => {
      if (!secretMatches(request.headers.authorization, config.ROBLOX_INGESTION_SECRET)) {
        return reply.code(401).send({ error: "invalid_authentication" });
      }
      const blocks = await service.activeBlocks();
      return reply.code(200).send({
        blocks: blocks.map((block) => ({
          // Roblox IDs cross the JSON boundary as decimal strings, both ways.
          userId: block.robloxUserId.toString(),
          username: block.robloxUsername,
          expiresAt: block.expiresAt.toISOString(),
        })),
      });
    });
  };
}
