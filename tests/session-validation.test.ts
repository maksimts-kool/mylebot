import { describe, expect, it, vi } from "vitest";
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

  it("does not process events while tracking is disabled", async () => {
    const disabled = new SessionService({ $transaction: vi.fn() } as never, config, {
      get: vi.fn().mockResolvedValue({ trackingEnabled: false }),
    } as never);
    await expect(disabled.process(base)).resolves.toMatchObject({ status: "tracking_disabled", changed: false });
  });

  it("purges a player's data and published session messages when their rank drops below the minimum", async () => {
    const transaction = {
      identity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "identity-1",
          sessions: [
            { id: "session-1", discordMessage: { channelId: "channel-1", messageId: "message-1" } },
            { id: "session-2", discordMessage: null },
          ],
        }),
        delete: vi.fn(),
      },
      auditEntry: { deleteMany: vi.fn() },
      processedEvent: { deleteMany: vi.fn() },
      session: { deleteMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (operation) => operation(transaction)) };
    const lowRank = new SessionService(db as never, config);

    await expect(lowRank.process({ ...base, player: { ...base.player, rankNumber: 9 } })).resolves.toEqual({
      eventId: base.eventId,
      status: "removed_low_rank",
      removedMessages: [{ channelId: "channel-1", messageId: "message-1" }],
      changed: false,
    });
    expect(transaction.auditEntry.deleteMany).toHaveBeenCalledWith({ where: { sessionId: { in: ["session-1", "session-2"] } } });
    expect(transaction.processedEvent.deleteMany).toHaveBeenCalledWith({ where: { sessionId: { in: ["session-1", "session-2"] } } });
    expect(transaction.session.deleteMany).toHaveBeenCalledWith({ where: { identityId: "identity-1" } });
    expect(transaction.identity.delete).toHaveBeenCalledWith({ where: { id: "identity-1" } });
  });
});
