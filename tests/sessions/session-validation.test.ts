import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { SessionService } from "../../src/features/sessions/service/session-service.js";

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

  it("ignores a teardown event from a server the player already left after hopping", async () => {
    const now = new Date();
    const existing = {
      id: "session-1", identityId: "identity-1", state: "ACTIVE", jobId: "server-b",
      startedAt: new Date(now.getTime() - 60_000), lastEventAt: new Date(now.getTime() - 30_000),
      lastStateAt: new Date(now.getTime() - 30_000), reconnectDeadline: null,
    };
    const transaction = {
      processedEvent: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      identity: { upsert: vi.fn().mockResolvedValue({ id: "identity-1" }) },
      session: { findFirst: vi.fn().mockResolvedValue(existing), update: vi.fn() },
      timeSegment: { updateMany: vi.fn(), create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (operation) => operation(transaction)) };
    const hopped = new SessionService(db as never, config);

    await expect(hopped.process({
      ...base, eventId: "0b3f1d4e-4c8a-4c2f-9c2a-1f2e3d4c5b6a", kind: "LEAVE",
      jobId: "server-a", occurredAt: now.toISOString(),
    })).resolves.toMatchObject({ status: "out_of_order", sessionId: "session-1", changed: false });
    expect(transaction.session.update).not.toHaveBeenCalled();
    expect(transaction.timeSegment.create).not.toHaveBeenCalled();
    expect(transaction.processedEvent.create).toHaveBeenCalledWith({
      data: { eventId: "0b3f1d4e-4c8a-4c2f-9c2a-1f2e3d4c5b6a", kind: "LEAVE", occurredAt: now, sessionId: "session-1" },
    });
  });

  it("only sweeps a stale session when its state and timestamp still match", async () => {
    const stale = {
      id: "session-1", state: "ACTIVE", lastEventAt: new Date("2026-01-01T00:00:00Z"),
      lastStateAt: new Date("2026-01-01T00:00:00Z"), reconnectDeadline: null,
    };
    const transaction = {
      session: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), update: vi.fn() },
      timeSegment: { updateMany: vi.fn(), create: vi.fn() },
    };
    const db = {
      session: {
        findMany: vi.fn()
          .mockResolvedValueOnce([stale])
          .mockResolvedValueOnce([]),
      },
      $transaction: vi.fn(async (operation) => operation(transaction)),
    };
    const sweeping = new SessionService(db as never, config);
    await expect(sweeping.sweep(new Date("2026-01-01T01:00:00Z"))).resolves.toEqual([]);
    expect(transaction.session.findFirst).toHaveBeenCalledWith({
      where: { id: stale.id, state: { in: ["ACTIVE", "INACTIVE"] }, lastEventAt: stale.lastEventAt, deletedAt: null },
    });
    expect(transaction.session.update).not.toHaveBeenCalled();
  });

  it("removes processed events older than the configured retention window", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 7 });
    const cleanup = new SessionService({ processedEvent: { deleteMany } } as never, config);
    const now = new Date("2026-02-01T00:00:00Z");
    await expect(cleanup.cleanupProcessedEvents(now)).resolves.toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ where: { receivedAt: { lt: new Date("2026-01-02T00:00:00Z") } } });
  });
});
