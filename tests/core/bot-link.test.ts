import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { botInternalRoutes, createBotLink, gatewayProxy, SESSIONS_CHANGED_PATH } from "../../src/core/bot-link.js";
import { loadConfig } from "../../src/core/config.js";
import { buildHttpServer } from "../../src/core/http.js";
import { createLogger } from "../../src/core/logger.js";

const base = {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
};
const secret = "internal-secret-at-least-16";
const serverConfig = loadConfig({ ...base, APP_ROLE: "server", BOT_INTERNAL_URL: "http://bot:3000", INTERNAL_SECRET: secret });
const botConfig = loadConfig({ ...base, APP_ROLE: "bot", INTERNAL_SECRET: secret });
const silent = createLogger({ service: "test", level: "silent" });

const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function proxyApp(): Promise<FastifyInstance> {
  const app = await buildHttpServer(serverConfig, undefined, silent);
  await app.register(gatewayProxy({ config: serverConfig, patterns: ["/internal/*", "/v1/taiga/*"], log: silent }));
  apps.push(app);
  return app;
}

describe("the split deployment's configuration", () => {
  it("refuses to start a half that cannot authenticate to the other", () => {
    expect(() => loadConfig({ ...base, APP_ROLE: "bot" })).toThrow(/INTERNAL_SECRET/);
    expect(() => loadConfig({ ...base, APP_ROLE: "server", INTERNAL_SECRET: secret })).toThrow(/BOT_INTERNAL_URL/);
  });

  it("hands out a link to the bot only to the half that needs one", () => {
    expect(createBotLink(serverConfig, silent)).not.toBeNull();
    expect(createBotLink(botConfig, silent)).toBeNull();
    expect(createBotLink(loadConfig(base), silent)).toBeNull();
  });
});

describe("forwarding the Discord-backed endpoints", () => {
  it("passes the body through byte for byte so a signature still verifies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "accepted" }), {
      status: 202, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await proxyApp();
    // Whitespace a re-encoding would quietly normalise away, breaking the HMAC.
    const body = '{ "action":"change",  "type":"userstory" }';

    const response = await app.inject({
      method: "POST",
      url: "/v1/taiga/webhook",
      headers: { "content-type": "application/json", "x-taiga-webhook-signature": "abc123" },
      payload: body,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://bot:3000/v1/taiga/webhook");
    expect(init.method).toBe("POST");
    expect(Buffer.from(init.body).toString()).toBe(body);
    expect(init.headers["x-taiga-webhook-signature"]).toBe("abc123");
  });

  it("keeps the caller's credentials and query string on the way through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await proxyApp();

    await app.inject({ method: "GET", url: "/internal/verified-members?page=2", headers: { authorization: "Bearer site-secret" } });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://bot:3000/internal/verified-members?page=2");
    expect(init.headers.authorization).toBe("Bearer site-secret");
    // A GET carries no body, and the hop's own connection headers are dropped.
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("content-length");
  });

  it("answers 503 rather than hanging when the bot container is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const app = await proxyApp();

    const response = await app.inject({ method: "POST", url: "/internal/notify", payload: { discordId: "1" } });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "bot_unavailable" });
  });
});

describe("the endpoint the server calls to refresh sessions", () => {
  async function botApp(onSessionsChanged = vi.fn().mockResolvedValue(undefined), config = botConfig) {
    const app = await buildHttpServer(config, undefined, silent);
    await app.register(botInternalRoutes({ config, onSessionsChanged }));
    apps.push(app);
    return { app, onSessionsChanged };
  }

  it("refreshes the sessions it is told about", async () => {
    const { app, onSessionsChanged } = await botApp();

    const response = await app.inject({
      method: "POST",
      url: SESSIONS_CHANGED_PATH,
      headers: { authorization: `Bearer ${secret}` },
      payload: { ids: ["session-1"], removedMessages: [{ channelId: "c", messageId: "m" }] },
    });

    expect(response.statusCode).toBe(202);
    expect(onSessionsChanged).toHaveBeenCalledWith(["session-1"], [{ channelId: "c", messageId: "m" }]);
  });

  it("turns away anything that does not carry the shared secret", async () => {
    const { app, onSessionsChanged } = await botApp();

    const missing = await app.inject({ method: "POST", url: SESSIONS_CHANGED_PATH, payload: { ids: [] } });
    const wrong = await app.inject({
      method: "POST", url: SESSIONS_CHANGED_PATH, headers: { authorization: "Bearer wrong-secret-16ch" }, payload: { ids: [] },
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });

  it("stays shut when no shared secret is configured at all", async () => {
    const { app, onSessionsChanged } = await botApp(vi.fn(), loadConfig(base));

    const response = await app.inject({ method: "POST", url: SESSIONS_CHANGED_PATH, payload: { ids: ["session-1"] } });

    expect(response.statusCode).toBe(503);
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });
});

describe("telling the bot what changed", () => {
  it("does not fail the caller's request when the bot cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const link = createBotLink(serverConfig, silent)!;

    await expect(link.sessionsChanged(["session-1"])).resolves.toBeUndefined();
  });

  it("says nothing when there is nothing to say", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const link = createBotLink(serverConfig, silent)!;

    await link.sessionsChanged([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
