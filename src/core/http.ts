import { timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { errorType } from "./errors.js";

export type Readiness = () => Promise<void>;

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
  log.error({ operation: "request_handling", errorType: errorType(error) }, "Unhandled request error");
  return reply.code(500).send({ error: "internal_error" });
}

/**
 * Builds the shared HTTP server: logging, rate limiting, health probes and the
 * default error contract. Features add their own routes afterwards with
 * `app.register(...)`, each in its own encapsulated scope.
 */
export async function buildHttpServer(config: Config, readiness: Readiness = async () => undefined): Promise<FastifyInstance> {
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

  app.setErrorHandler((error, _request, reply) => replyWithDefaultError(app.log, error, reply));
  return app;
}
