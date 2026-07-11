import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SessionService } from "../src/services/session-service.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300,301",
  ROBLOX_MIN_RANK: "10",
  ROBLOX_MAX_RANK: "20",
  MAX_EVENT_AGE_SECONDS: "300",
});
const service = new SessionService({} as never, config);
const base = {
  eventId: "650daf2b-79b0-4d70-9c19-2a280fa3ac39",
  kind: "JOIN" as const,
  occurredAt: new Date().toISOString(), universeId: 100n, placeId: 300n, jobId: "job",
  player: { userId: 1n, username: "Tester", rankNumber: 10, rankName: "Staff", active: true },
};

describe("ingestion validation", () => {
  it("accepts inclusive rank boundaries", () => {
    expect(() => service.validate(base)).not.toThrow();
    expect(() => service.validate({ ...base, player: { ...base.player, rankNumber: 20 } })).not.toThrow();
  });

  it("rejects ranks, places, universes, and stale events outside configuration", () => {
    expect(() => service.validate({ ...base, player: { ...base.player, rankNumber: 9 } })).toThrow(/rank/);
    expect(() => service.validate({ ...base, placeId: 999n })).toThrow(/place/);
    expect(() => service.validate({ ...base, universeId: 999n })).toThrow(/universe/);
    expect(() => service.validate({ ...base, occurredAt: new Date(Date.now() - 301_000).toISOString() })).toThrow(/timestamp/);
  });
});
