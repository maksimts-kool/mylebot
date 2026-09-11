import { timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { errorType } from "./errors.js";
import { createAppLogger, type Logger } from "./logger.js";

export type Readiness = () => Promise<void>;

/** Probes the orchestrator polls constantly. They are only worth a line when they fail. */
const PROBE_PATHS = new Set(["/health", "/ready"]);

/** A request slower than this is worth reading about even if it succeeded. */
const SLOW_REQUEST_MS = 1000;

/** Constant-time comparison of a `Bearer <secret>` header against a shared secret. */
export function secretMatches(header: string | undefined, expected: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * The fallback error response. Features that register their own error handler
 * should delegate here for anything they do not recognise, so every route keeps
 * the same payload-validation and internal-error contract.
 */
export function replyWithDefaultError(log: FastifyBaseLogger, error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof ZodError) return reply.code(400).send({ error: "invalid_payload", details: error.flatten() });
  log.error({ category: "http", err: error, errorType: errorType(error) }, "Unhandled request error");
  return reply.code(500).send({ error: "internal_error" });
}

/**
 * Builds the shared HTTP server: logging, rate limiting, health probes and the
 * default error contract. Features add their own routes afterwards with
 * `app.register(...)`, each in its own encapsulated scope.
 */
export async function buildHttpServer(
  config: Config,
  readiness: Readiness = async () => undefined,
  log: Logger = createAppLogger(config),
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    // Fastify's own pair of lines per request carries nothing a reader wants:
    // the `onResponse` hook below logs one line, and only when it says something.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    trustProxy: config.TRUST_PROXY === "loopback" ? "127.0.0.1/8" : false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.addHook("onResponse", async (request, reply) => {
    const durationMs = reply.elapsedTime;
    const path = request.url.split("?")[0] ?? request.url;
    const healthy = reply.statusCode < 400;
    if (PROBE_PATHS.has(path) && healthy && durationMs < SLOW_REQUEST_MS) return;
    const level = reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info";
    log[level]({ category: "http", durationMs }, `${request.method} ${path} → ${reply.statusCode}`);
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await readiness();
      return { status: "ready" };
    } catch (error) {
      log.error({ category: "db", err: error, errorType: errorType(error) }, "Readiness check failed");
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.setErrorHandler((error, _request, reply) => replyWithDefaultError(app.log, error, reply));
  return app;
}
