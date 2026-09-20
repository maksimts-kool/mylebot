import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/core/config.js";
import { buildHttpServer } from "../../src/core/http.js";
import { commandBlockRoutes, commandRunRoutes } from "../../src/features/command-logs/api/routes.js";
import type { CommandLogService } from "../../src/features/command-logs/service/command-log-service.js";

const config = loadConfig({
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
  MAX_BATCH_SIZE: "1",
});
const authorized = { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` };

const validEvent = {
  eventId: "650daf2b-79b0-4d70-9c19-2a280fa3ac39",
  occurredAt: new Date().toISOString(),
  universeId: "100",
  placeId: "300",
  jobId: "job-1",
  serverType: "PUBLIC",
  playerCount: 14,
  maxPlayers: 30,
  runner: { userId: "999", username: "MaksimTs", rankNumber: 9, rankName: "Supervisor", adminLevel: 201 },
  command: { text: ":kick Kiryoku", name: "Kick", alias: "kick", requiredLevel: 201 },
  targets: ["Kiryoku"],
};

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function buildApp(service: Partial<CommandLogService>, onRecorded = vi.fn()): Promise<FastifyInstance> {
  const app = await buildHttpServer(config);
  await app.register(commandRunRoutes({ config, service: service as CommandLogService, onRecorded }));
  await app.register(commandBlockRoutes({ config, service: service as CommandLogService }));
  apps.push(app);
  return app;
}

describe("command run ingestion", () => {
  it("rejects an unauthenticated batch before reading it", async () => {
    const record = vi.fn();
    const app = await buildApp({ record });
    const response = await app.inject({ method: "POST", url: "/v1/roblox/commands/batch", payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("posts what it recorded and reports each event's outcome", async () => {
    const entry = { id: "entry-1" };
    const record = vi.fn().mockResolvedValue({ status: "recorded", entry });
    const onRecorded = vi.fn();
    const app = await buildApp({ record }, onRecorded);
    const response = await app.inject({
      method: "POST", url: "/v1/roblox/commands/batch", headers: authorized, payload: { events: [validEvent] },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ results: [{ eventId: validEvent.eventId, status: "recorded" }] });
    expect(onRecorded).toHaveBeenCalledWith([entry]);
  });

  it("says why a run was not kept, and posts nothing", async () => {
    const record = vi.fn().mockResolvedValue({ status: "skipped", reason: "quiet_command" });
    const onRecorded = vi.fn();
    const app = await buildApp({ record }, onRecorded);
    const response = await app.inject({
      method: "POST", url: "/v1/roblox/commands/batch", headers: authorized, payload: { events: [validEvent] },
    });
    expect(response.json().results[0]).toEqual({ eventId: validEvent.eventId, status: "skipped", reason: "quiet_command" });
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("turns down a batch larger than the configured limit", async () => {
    const app = await buildApp({ record: vi.fn() });
    const response = await app.inject({
      method: "POST", url: "/v1/roblox/commands/batch", headers: authorized,
      payload: { events: [validEvent, { ...validEvent, eventId: "650daf2b-79b0-4d70-9c19-2a280fa3ac40" }] },
    });
    expect(response.statusCode).toBe(413);
  });

  it("answers a malformed payload and a wrong universe differently", async () => {
    const record = vi.fn().mockRejectedValue(new Error("Unexpected universe 999"));
    const app = await buildApp({ record });
    const malformed = await app.inject({
      method: "POST", url: "/v1/roblox/commands/batch", headers: authorized,
      payload: { events: [{ ...validEvent, serverType: "RESERVED" }] },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("invalid_payload");

    const rejected = await app.inject({
      method: "POST", url: "/v1/roblox/commands/batch", headers: authorized, payload: { events: [validEvent] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("rejected_event");
  });
});

describe("the block list the plugin polls", () => {
  it("needs the ingestion secret", async () => {
    const activeBlocks = vi.fn();
    const app = await buildApp({ activeBlocks });
    expect((await app.inject({ method: "GET", url: "/v1/roblox/command-blocks" })).statusCode).toBe(401);
    expect(activeBlocks).not.toHaveBeenCalled();
  });

  it("sends Roblox IDs as decimal strings, never as JSON numbers", async () => {
    const expiresAt = new Date("2026-09-20T18:57:00Z");
    const activeBlocks = vi.fn().mockResolvedValue([
      { robloxUserId: 999999999999999999n, robloxUsername: "MaksimTs", expiresAt },
    ]);
    const app = await buildApp({ activeBlocks });
    const response = await app.inject({ method: "GET", url: "/v1/roblox/command-blocks", headers: authorized });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      blocks: [{ userId: "999999999999999999", username: "MaksimTs", expiresAt: expiresAt.toISOString() }],
    });
  });
});
