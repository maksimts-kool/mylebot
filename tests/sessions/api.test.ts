import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/core/config.js";
import { buildHttpServer, type Readiness } from "../../src/core/http.js";
import { createLogger } from "../../src/core/logger.js";
import { sessionRoutes, type SessionsChanged } from "../../src/features/sessions/api/routes.js";
import { summarizePresenceBatch } from "../../src/features/sessions/domain/events.js";
import type { SessionService } from "../../src/features/sessions/service/session-service.js";

const config = loadConfig({
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
  MAX_BATCH_SIZE: "1",
});
const validEvent = {
  eventId: "650daf2b-79b0-4d70-9c19-2a280fa3ac39",
  kind: "JOIN", occurredAt: new Date().toISOString(), universeId: "100", placeId: "300", jobId: "job",
  player: { userId: "999999999999999999", username: "Tester", rankNumber: 1, rankName: "Staff", active: true },
};
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

/** Every line the server logged, parsed from the JSON format. */
let logged: Array<{ level: string; msg: string } & Record<string, unknown>> = [];

async function buildApp(sessions: SessionService, onChanged: SessionsChanged, readiness?: Readiness): Promise<FastifyInstance> {
  logged = [];
  const log = createLogger({ service: "server", level: "debug", format: "json", write: (line) => logged.push(JSON.parse(line)) });
  const app = await buildHttpServer(config, readiness, log);
  await app.register(sessionRoutes({ config, sessions, onChanged }));
  apps.push(app);
  return app;
}

function requestLine(path: string) {
  return logged.find((line) => line.category === "http" && line.msg.includes(path));
}

describe("ingestion API", () => {
  it("reports liveness independently and readiness failures as unavailable", async () => {
    const readiness = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const app = await buildApp({ process: vi.fn() } as never, async () => {}, readiness);
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(readiness).toHaveBeenCalledOnce();
  });

  it("rejects missing authentication before processing the body", async () => {
    const process = vi.fn(); const app = await buildApp({ process } as never, async () => {});
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(401); expect(process).not.toHaveBeenCalled();
  });

  it("accepts an authenticated event and reports changed sessions", async () => {
    const process = vi.fn().mockResolvedValue({ eventId: validEvent.eventId, status: "accepted", sessionId: "session-1", changed: true });
    const changed = vi.fn(); const app = await buildApp({ process } as never, changed);
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(202); expect(process).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledWith(["session-1"]);
    // A batch that changed a shift says so at the default level.
    const line = requestLine("/v1/roblox/presence/batch");
    expect(line).toMatchObject({ level: "info", msg: "POST /v1/roblox/presence/batch → 202: 1 join; 1 shift changed" });
    expect(JSON.stringify(logged)).not.toContain(config.ROBLOX_INGESTION_SECRET);
    expect(JSON.stringify(logged)).not.toContain(validEvent.player.userId);
  });

  it("keeps a batch that changed nothing out of the default log", async () => {
    const process = vi.fn().mockResolvedValue({ eventId: validEvent.eventId, status: "accepted", sessionId: "session-1", changed: false });
    const app = await buildApp({ process } as never, vi.fn());
    const heartbeat = { ...validEvent, kind: "HEARTBEAT" };
    await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [heartbeat] } });
    expect(requestLine("/v1/roblox/presence/batch")).toMatchObject({
      level: "debug", msg: "POST /v1/roblox/presence/batch → 202: 1 heartbeat; nothing changed",
    });
  });

  it("says why a request was turned away", async () => {
    const app = await buildApp({ process: vi.fn() } as never, vi.fn());
    await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", payload: { events: [validEvent] } });
    expect(requestLine("/v1/roblox/presence/batch")).toMatchObject({
      level: "warn", msg: "POST /v1/roblox/presence/batch → 401: wrong ingestion secret",
    });
  });

  it("passes low-rank Discord messages to the publisher for deletion", async () => {
    const process = vi.fn().mockResolvedValue({
      eventId: validEvent.eventId,
      status: "removed_low_rank",
      changed: false,
      removedMessages: [{ channelId: "channel-1", messageId: "message-1" }],
    });
    const changed = vi.fn(); const app = await buildApp({ process } as never, changed);
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(202);
    expect(changed).toHaveBeenCalledWith([], [{ channelId: "channel-1", messageId: "message-1" }]);
  });

  it("enforces the configured batch limit", async () => {
    const app = await buildApp({ process: vi.fn() } as never, async () => {});
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [validEvent, { ...validEvent, eventId: "6bad52ed-746f-4e7c-b6c1-544065466ddf" }] } });
    expect(response.statusCode).toBe(413);
  });

  it("reports a source-rejected event separately from an internal failure", async () => {
    const process = vi.fn().mockRejectedValue(new Error("Unknown place ID"));
    const app = await buildApp({ process } as never, async () => {});
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "rejected_event" });
  });

  it("reports a malformed payload as a validation failure, not a rejected event", async () => {
    const app = await buildApp({ process: vi.fn() } as never, async () => {});
    const response = await app.inject({
      method: "POST", url: "/v1/roblox/presence/batch",
      headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` },
      payload: { events: [{ ...validEvent, placeId: "not-a-number" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_payload" });
  });
});

describe("presence batch summaries", () => {
  it("counts each kind of event and the shifts that changed", () => {
    expect(summarizePresenceBatch(["HEARTBEAT", "JOIN", "HEARTBEAT"], ["accepted", "accepted", "accepted"], 1)).toEqual({
      did: "1 join, 2 heartbeats; 1 shift changed", routine: false,
    });
  });

  it("treats a batch that changed nothing as routine, and notes what was skipped", () => {
    expect(summarizePresenceBatch(["HEARTBEAT", "HEARTBEAT"], ["accepted", "duplicate"], 0)).toEqual({
      did: "2 heartbeats; nothing changed; 1 already applied", routine: true,
    });
    expect(summarizePresenceBatch(["HEARTBEAT"], ["tracking_disabled"], 0).did).toBe("1 heartbeat; nothing changed; 1 ignored because tracking is off");
  });

  it("never treats a low-rank purge as routine", () => {
    expect(summarizePresenceBatch(["HEARTBEAT"], ["removed_low_rank"], 0).routine).toBe(false);
  });
});
