import type { FastifyPluginAsync } from "fastify";
import { UserFacingError, errorType } from "./errors.js";
import { describeRequest, secretMatches } from "./http.js";
import type { Logger } from "./logger.js";

/**
 * How the two halves of the application talk to each other.
 *
 * The `server` half owns the database and every integration; the `bot` half
 * owns the Discord gateway and nothing else. Each half offers the other a few
 * *ports*: plain objects of async methods, named by the feature they belong
 * to. A half calls the other's ports through a `Peer`, which either crosses
 * the private container network (two containers) or calls straight into the
 * same process (`APP_ROLE=all`). Both paths encode and decode every argument
 * and answer the same way, so a single-process run exercises exactly what the
 * wire would carry.
 *
 * Only own enumerable function properties of an exposed object can be called,
 * so a port is always an object literal listing what it offers — never a class
 * instance whose prototype would leak.
 */

export const LINK_PATH_PREFIX = "/internal/link";

/** Generous: a call may wait on Discord's rate limits or a Taiga round trip. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Profile cards and command batches travel this way; nothing legitimate comes close. */
const LINK_BODY_LIMIT = 8 * 1024 * 1024;

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------- Errors

/**
 * The other half could not be reached, or cannot act right now — the bot is
 * restarting, or Discord is not connected. Callers on a timer should treat it
 * as "try again later" rather than as a failure worth an error line.
 */
export class LinkUnavailableError extends Error {
  override name = "LinkUnavailableError";
}

/** The other half tried and failed. Its own log carries the stack. */
export class RemoteError extends Error {
  override name = "RemoteError";
}

type WireError = { kind: "user" | "unavailable" | "internal"; message: string };

function toWire(error: unknown): WireError {
  if (error instanceof UserFacingError) return { kind: "user", message: error.message };
  if (error instanceof LinkUnavailableError) return { kind: "unavailable", message: error.message };
  return { kind: "internal", message: `${errorType(error)}: ${error instanceof Error ? error.message : String(error)}` };
}

function fromWire(error: WireError, label: string): Error {
  if (error.kind === "user") return new UserFacingError(error.message);
  if (error.kind === "unavailable") return new LinkUnavailableError(`${label}: ${error.message}`);
  return new RemoteError(`${label} failed: ${error.message}`);
}

// ---------------------------------------------------------------- Codec

const TAG = "$link";
type TaggedValue = { [TAG]: "date" | "bigint" | "bytes" | "map" | "set"; v: unknown };

/**
 * JSON that keeps the types this application passes around: instants, Roblox
 * ids as `bigint`, PNG bytes, and the maps the panels are rendered from.
 * Nothing is ever serialised as a native `bigint`; it travels as a tagged
 * decimal string.
 */
export function encodeLink(value: unknown): string {
  const text = JSON.stringify(value, function replacer(this: Record<string, unknown>, key: string, current: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return { [TAG]: "date", v: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
    if (typeof current === "bigint") return { [TAG]: "bigint", v: current.toString() };
    if (raw instanceof Uint8Array) return { [TAG]: "bytes", v: Buffer.from(raw).toString("base64") };
    if (raw instanceof Map) return { [TAG]: "map", v: [...raw.entries()] };
    if (raw instanceof Set) return { [TAG]: "set", v: [...raw.values()] };
    return current;
  });
  return text ?? "null";
}

export function decodeLink(text: string): unknown {
  if (!text) return undefined;
  return JSON.parse(text, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !(TAG in value)) return value;
    const tagged = value as TaggedValue;
    switch (tagged[TAG]) {
      case "date": return new Date(typeof tagged.v === "string" ? tagged.v : Number.NaN);
      case "bigint": return BigInt(String(tagged.v));
      case "bytes": return Buffer.from(String(tagged.v), "base64");
      case "map": return new Map(tagged.v as Array<[unknown, unknown]>);
      case "set": return new Set(tagged.v as unknown[]);
      default: return value;
    }
  });
}

type Envelope = { ok: true; value?: unknown } | { ok: false; error: WireError };

// ---------------------------------------------------------------- Exposing ports

type Handled = { status: number; body: string };

/** The ports one half offers the other. */
export class PortRegistry {
  private readonly ports = new Map<string, object>();

  constructor(private readonly log: Logger) {}

  /** Offers `impl` under `name`. `impl` must be an object literal of async methods. */
  expose<T extends object>(name: string, impl: T): void {
    if (!NAME.test(name)) throw new Error(`Invalid port name: ${name}`);
    if (this.ports.has(name)) throw new Error(`Port ${name} is already exposed`);
    this.ports.set(name, impl);
  }

  private method(port: string, method: string): ((...args: unknown[]) => Promise<unknown>) | null {
    const impl = this.ports.get(port) as Record<string, unknown> | undefined;
    if (!impl || !NAME.test(method) || !Object.hasOwn(impl, method)) return null;
    const fn = impl[method];
    return typeof fn === "function" ? (fn as (...args: unknown[]) => Promise<unknown>).bind(impl) : null;
  }

  /**
   * Runs one call from its encoded arguments and answers with an encoded
   * envelope. An answer the caller should act on — a refusal, "not now", even
   * a failure — is a 200 with `ok: false`; only a request this registry cannot
   * make sense of gets another status.
   */
  async handle(port: string, method: string, body: string): Promise<Handled> {
    const fn = this.method(port, method);
    if (!fn) return { status: 404, body: encodeLink({ ok: false, error: { kind: "internal", message: `No such port method ${port}.${method}` } }) };
    let args: unknown;
    try {
      args = (decodeLink(body) as { args?: unknown } | undefined)?.args ?? [];
    } catch {
      return { status: 400, body: encodeLink({ ok: false, error: { kind: "internal", message: "Malformed link request" } }) };
    }
    if (!Array.isArray(args)) return { status: 400, body: encodeLink({ ok: false, error: { kind: "internal", message: "Link arguments must be a list" } }) };
    try {
      const value = await fn(...args);
      return { status: 200, body: encodeLink({ ok: true, value } satisfies Envelope) };
    } catch (error) {
      const wire = toWire(error);
      // A refusal or "not now" is the caller's to report. A failure is only
      // ever seen in full here, so it is logged here.
      if (wire.kind === "internal") {
        this.log.error({ category: "http", err: error, errorType: errorType(error), port, method }, `${port}.${method} failed`);
      }
      return { status: 200, body: encodeLink({ ok: false, error: wire } satisfies Envelope) };
    }
  }
}

/**
 * The route the other container calls. Only ever reachable on the private
 * network, and authenticated with `INTERNAL_SECRET` all the same.
 */
export function linkRoutes(options: { registry: PortRegistry; secret: string }): FastifyPluginAsync {
  const { registry, secret } = options;
  return async (app) => {
    // The codec needs the text; Fastify's parser would hand over an object
    // that has already lost its dates and ids.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string", bodyLimit: LINK_BODY_LIMIT }, (_request, body, done) => { done(null, body); });

    app.post<{ Params: { port: string; method: string } }>(
      `${LINK_PATH_PREFIX}/:port/:method`,
      // The other container calls this many times a minute by design.
      { config: { rateLimit: false } },
      async (request, reply) => {
        // An empty secret would make the comparison below pass for everyone.
        if (!secret) return reply.code(503).send({ error: "internal_api_disabled" });
        if (!secretMatches(request.headers.authorization, secret)) {
          describeRequest(request, { did: "wrong internal secret" });
          return reply.code(401).send({ error: "invalid_authentication" });
        }
        const { port, method } = request.params;
        const result = await registry.handle(port, method, typeof request.body === "string" ? request.body : "");
        // Each side logs what the call actually did; this line is the call.
        describeRequest(request, { did: `ran ${port}.${method}`, routine: true });
        return reply.code(result.status).header("content-type", "application/json").send(result.body);
      },
    );
  };
}

// ---------------------------------------------------------------- Calling ports

/** A handle on the other half. */
export interface Peer {
  /**
   * A typed handle on one of the other half's ports. Nothing is checked until
   * a method is called, so the port may be exposed after this is taken.
   */
  port<T extends object>(name: string): T;
}

type Call = (port: string, method: string, args: unknown[]) => Promise<unknown>;

function portProxy<T extends object>(port: string, call: Call): T {
  return new Proxy({}, {
    get(_target, property) {
      // Never look like a promise, or `await port` would call `then`.
      if (typeof property !== "string" || property === "then") return undefined;
      return (...args: unknown[]) => call(port, property, args);
    },
  }) as T;
}

function settle(envelope: Envelope, label: string): unknown {
  if (envelope.ok) return envelope.value;
  throw fromWire(envelope.error, label);
}

/**
 * Both halves in one process. Calls still go through the codec and the
 * envelope, so anything that would not survive the wire fails here too.
 */
export function localPeer(registry: PortRegistry): Peer {
  const call: Call = async (port, method, args) => {
    const handled = await registry.handle(port, method, encodeLink({ args }));
    return settle(decodeLink(handled.body) as Envelope, `${port}.${method}`);
  };
  return { port: (name) => portProxy(name, call) };
}

export type HttpPeerOptions = {
  /** `http://bot:3000` — the other container on the private network. */
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
};

/** The other half in its own container. */
export function httpPeer({ baseUrl, secret, timeoutMs = DEFAULT_TIMEOUT_MS }: HttpPeerOptions): Peer {
  const call: Call = async (port, method, args) => {
    const label = `${port}.${method}`;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${LINK_PATH_PREFIX}/${port}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: encodeLink({ args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new LinkUnavailableError(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const text = await response.text();
    let envelope: Envelope | undefined;
    try {
      envelope = decodeLink(text) as Envelope | undefined;
    } catch {
      envelope = undefined;
    }
    if (envelope && typeof envelope === "object" && "ok" in envelope) return settle(envelope, label);
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new LinkUnavailableError(`${label}: the other container answered ${response.status}`);
    }
    throw new RemoteError(`${label}: the other container answered ${response.status}`);
  };
  return { port: (name) => portProxy(name, call) };
}
