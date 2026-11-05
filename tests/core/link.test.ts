import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/core/config.js";
import { UserFacingError } from "../../src/core/errors.js";
import { buildHttpServer } from "../../src/core/http.js";
import {
  LINK_PATH_PREFIX, LinkUnavailableError, PortRegistry, RemoteError, decodeLink, encodeLink, httpPeer, linkRoutes, localPeer,
} from "../../src/core/link.js";
import { createLogger } from "../../src/core/logger.js";

const serverEnv = {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
};
const secret = "internal-secret-at-least-16";
const silent = createLogger({ service: "test", level: "silent" });

const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type Greeter = {
  greet(name: string, at: Date): Promise<{ text: string; at: Date }>;
  refuse(): Promise<void>;
  away(): Promise<void>;
  crash(): Promise<void>;
};

function greeterRegistry() {
  const registry = new PortRegistry(silent);
  const greeter: Greeter = {
    greet: async (name, at) => ({ text: `hello ${name}`, at }),
    refuse: async () => { throw new UserFacingError("Manager role required"); },
    away: async () => { throw new LinkUnavailableError("Discord is not connected"); },
    crash: async () => { throw new Error("database exploded"); },
  };
  registry.expose("greeter", greeter);
  return registry;
}

describe("which half needs what", () => {
  it("asks the bot half for nothing the server half owns", () => {
    const config = loadConfig({
      LOG_LEVEL: "silent", APP_ROLE: "bot", INTERNAL_SECRET: secret, SERVER_INTERNAL_URL: "http://server:3000", DISCORD_TOKEN: "token",
    });
    expect(config.DATABASE_URL).toBe("");
    expect(config.ROBLOX_INGESTION_SECRET).toBe("");
  });

  it("refuses to start a half that cannot reach or authenticate to the other", () => {
    expect(() => loadConfig({ ...serverEnv, APP_ROLE: "bot" })).toThrow(/INTERNAL_SECRET/);
    expect(() => loadConfig({ APP_ROLE: "bot", INTERNAL_SECRET: secret, DISCORD_TOKEN: "token" })).toThrow(/SERVER_INTERNAL_URL/);
    expect(() => loadConfig({ APP_ROLE: "bot", INTERNAL_SECRET: secret, SERVER_INTERNAL_URL: "http://server:3000" })).toThrow(/DISCORD_TOKEN/);
    expect(() => loadConfig({ ...serverEnv, APP_ROLE: "server", INTERNAL_SECRET: secret })).toThrow(/BOT_INTERNAL_URL/);
  });

  it("still asks the server half for its database and its Roblox settings", () => {
    expect(() => loadConfig({ ...serverEnv, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...serverEnv, ROBLOX_UNIVERSE_ID: "" })).toThrow(/ROBLOX_UNIVERSE_ID/);
    expect(() => loadConfig({ ...serverEnv, ROBLOX_ALLOWED_PLACE_IDS: "" })).toThrow(/ROBLOX_ALLOWED_PLACE_IDS/);
  });
});

describe("the link codec", () => {
  it("keeps instants, Roblox ids, bytes and maps across the wire", () => {
    const value = {
      at: new Date("2026-11-05T12:00:00Z"),
      robloxUserId: 1234567890123456789n,
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      blocked: new Map([["1", new Date("2026-11-05T12:15:00Z")]]),
      seen: new Set(["a", "b"]),
      nested: [{ placeId: 300n, endedAt: null }],
    };
    const decoded = decodeLink(encodeLink(value)) as typeof value;
    expect(decoded.at).toEqual(value.at);
    expect(decoded.robloxUserId).toBe(1234567890123456789n);
    expect(Buffer.isBuffer(decoded.png) && decoded.png.equals(value.png)).toBe(true);
    expect(decoded.blocked.get("1")).toEqual(new Date("2026-11-05T12:15:00Z"));
    expect([...decoded.seen]).toEqual(["a", "b"]);
    expect(decoded.nested).toEqual([{ placeId: 300n, endedAt: null }]);
  });

  it("never puts a native bigint on the wire", () => {
    expect(encodeLink({ id: 5n })).toBe('{"id":{"$link":"bigint","v":"5"}}');
  });
});

describe("a port in the same process", () => {
  const peer = localPeer(greeterRegistry());
  const greeter = peer.port<Greeter>("greeter");

  it("answers through the codec, as the wire would", async () => {
    const at = new Date("2026-11-05T12:00:00Z");
    const answer = await greeter.greet("wolfik", at);
    expect(answer).toEqual({ text: "hello wolfik", at });
    expect(answer.at).not.toBe(at);
  });

  it("keeps a refusal user-facing, and tells unavailability apart from a failure", async () => {
    await expect(greeter.refuse()).rejects.toThrow(UserFacingError);
    await expect(greeter.away()).rejects.toThrow(LinkUnavailableError);
    await expect(greeter.crash()).rejects.toThrow(RemoteError);
  });

  it("can only call what the port itself offers", async () => {
    for (const method of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      await expect((greeter as unknown as Record<string, () => Promise<unknown>>)[method]!()).rejects.toThrow(/No such port method/);
    }
    await expect(peer.port<Greeter>("missing").refuse()).rejects.toThrow(/No such port method/);
  });

  it("does not look like a promise", async () => {
    expect(await Promise.resolve(greeter)).toBe(greeter);
  });
});

describe("a port in the other container", () => {
  async function linkApp(linkSecret = secret): Promise<FastifyInstance> {
    const config = loadConfig({ ...serverEnv, APP_ROLE: "server", BOT_INTERNAL_URL: "http://bot:3000", INTERNAL_SECRET: secret });
    const app = await buildHttpServer(config, undefined, silent);
    await app.register(linkRoutes({ registry: greeterRegistry(), secret: linkSecret }));
    apps.push(app);
    return app;
  }

  /** Points `fetch` at the app, so the HTTP peer is exercised end to end. */
  function routeFetchTo(app: FastifyInstance) {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const response = await app.inject({
        method: "POST",
        url: new URL(url).pathname,
        headers: init.headers as Record<string, string>,
        payload: init.body as string,
      });
      return new Response(response.body, { status: response.statusCode });
    });
  }

  it("refuses a caller without the shared secret", async () => {
    const app = await linkApp();
    const response = await app.inject({
      method: "POST", url: `${LINK_PATH_PREFIX}/greeter/greet`, headers: { authorization: "Bearer wrong-secret-entirely" }, payload: "{}",
    });
    expect(response.statusCode).toBe(401);
  });

  it("is switched off without a secret rather than open to everyone", async () => {
    const app = await linkApp("");
    const response = await app.inject({ method: "POST", url: `${LINK_PATH_PREFIX}/greeter/greet`, headers: { authorization: "Bearer " }, payload: "{}" });
    expect(response.statusCode).toBe(503);
  });

  it("carries a call and its answer across HTTP", async () => {
    routeFetchTo(await linkApp());
    const greeter = httpPeer({ baseUrl: "http://server:3000", secret }).port<Greeter>("greeter");
    const at = new Date("2026-11-05T12:00:00Z");
    expect(await greeter.greet("wolfik", at)).toEqual({ text: "hello wolfik", at });
    await expect(greeter.refuse()).rejects.toThrow("Manager role required");
    await expect(greeter.away()).rejects.toThrow(LinkUnavailableError);
  });

  it("is not rate limited like the public endpoints", async () => {
    routeFetchTo(await linkApp());
    const greeter = httpPeer({ baseUrl: "http://server:3000", secret }).port<Greeter>("greeter");
    const at = new Date();
    // The public limit is 120 a minute; the other container is not a client.
    for (let call = 0; call < 130; call += 1) await greeter.greet("again", at);
  });

  it("reports a container it cannot reach as unavailable", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    const greeter = httpPeer({ baseUrl: "http://bot:3000", secret }).port<Greeter>("greeter");
    await expect(greeter.greet("anyone", new Date())).rejects.toThrow(LinkUnavailableError);
  });
});
