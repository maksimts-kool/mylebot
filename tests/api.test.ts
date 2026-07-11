import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/api.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
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
  player: { userId: "1", username: "Tester", rankNumber: 1, rankName: "Staff", active: true },
};
const apps: Array<Awaited<ReturnType<typeof buildApi>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("ingestion API", () => {
  it("rejects missing authentication before processing the body", async () => {
    const process = vi.fn(); const app = await buildApi(config, { process } as never, async () => {}); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(401); expect(process).not.toHaveBeenCalled();
  });

  it("accepts an authenticated event and reports changed sessions", async () => {
    const process = vi.fn().mockResolvedValue({ eventId: validEvent.eventId, status: "accepted", sessionId: "session-1", changed: true });
    const changed = vi.fn(); const app = await buildApi(config, { process } as never, changed); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [validEvent] } });
    expect(response.statusCode).toBe(202); expect(process).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledWith(["session-1"]);
  });

  it("enforces the configured batch limit", async () => {
    const app = await buildApi(config, { process: vi.fn() } as never, async () => {}); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/roblox/presence/batch", headers: { authorization: `Bearer ${config.ROBLOX_INGESTION_SECRET}` }, payload: { events: [validEvent, { ...validEvent, eventId: "6bad52ed-746f-4e7c-b6c1-544065466ddf" }] } });
    expect(response.statusCode).toBe(413);
  });
});
