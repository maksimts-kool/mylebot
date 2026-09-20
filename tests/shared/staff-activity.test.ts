import { describe, expect, it, vi } from "vitest";
import {
  commandActivityDuring, compactDuration, shiftStatusAt, timeIntoShift, topCommandsLine,
} from "../../src/shared/staff-activity.js";

const from = new Date("2026-09-20T18:00:00Z");
const to = new Date("2026-09-20T20:00:00Z");

/** A `groupBy` answer, shaped as Prisma returns it. */
function group(commandName: string, risk: string, count: number) {
  return { commandName, risk, _count: { _all: count } };
}

function dbWithGroups(groups: ReturnType<typeof group>[]) {
  return { commandLogEntry: { groupBy: vi.fn().mockResolvedValue(groups) } };
}

describe("the commands run during a shift", () => {
  it("counts them by risk and by command, worst and most-run first", async () => {
    const db = dbWithGroups([
      group("Respawn", "LOW", 3),
      group("Kick", "MEDIUM", 4),
      group("Ban", "HIGH", 1),
      group("Message", "LOW", 1),
    ]);

    const activity = await commandActivityDuring(db as never, { robloxUserId: 999n, from, to });

    expect(activity.total).toBe(9);
    expect(activity.highestRisk).toBe("HIGH");
    expect(activity.byRisk).toEqual([
      { risk: "HIGH", count: 1 },
      { risk: "MEDIUM", count: 4 },
      { risk: "LOW", count: 4 },
    ]);
    expect(topCommandsLine(activity)).toBe("Kick ×4 · Respawn ×3 · Ban ×1");
  });

  it("asks only about that person, and only about the shift's own window", async () => {
    const db = dbWithGroups([]);

    const activity = await commandActivityDuring(db as never, { robloxUserId: 999n, from, to });

    expect(db.commandLogEntry.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { robloxUserId: 999n, occurredAt: { gte: from, lte: to } },
    }));
    expect(activity.total).toBe(0);
    expect(activity.highestRisk).toBeNull();
    expect(topCommandsLine(activity)).toBe("");
  });
});

describe("whether somebody was on shift", () => {
  const shift = { id: "session-1", startedAt: from, endedAt: null };

  function dbWithIdentities(identities: Array<{ robloxUserId: bigint; sessions: typeof shift[] }>) {
    return { identity: { findMany: vi.fn().mockResolvedValue(identities) } };
  }

  it("tells a shift, no shift, and somebody never tracked apart", async () => {
    const db = dbWithIdentities([
      { robloxUserId: 999n, sessions: [shift] },
      { robloxUserId: 1000n, sessions: [] },
    ]);

    const statuses = await shiftStatusAt(db as never, [999n, 1000n, 1001n], to);

    expect(statuses.get("999")).toEqual({ tracked: true, shift });
    expect(statuses.get("1000")).toEqual({ tracked: true, shift: null });
    // Never seen by the tracker: nothing is known, so nothing is claimed.
    expect(statuses.get("1001")).toEqual({ tracked: false });
  });

  it("only counts a shift that covers the instant asked about", async () => {
    const db = dbWithIdentities([]);

    await shiftStatusAt(db as never, [999n], to);

    expect(db.identity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { robloxUserId: { in: [999n] } },
    }));
    const { select } = db.identity.findMany.mock.calls[0]![0] as {
      select: { sessions: { where: Record<string, unknown> } };
    };
    expect(select.sessions.where).toEqual({
      deletedAt: null,
      startedAt: { lte: to },
      OR: [{ endedAt: null }, { endedAt: { gte: to } }],
    });
  });

  it("measures how far into a shift an instant was", () => {
    expect(timeIntoShift({ tracked: true, shift }, to)).toBe(2 * 60 * 60 * 1000);
    expect(timeIntoShift({ tracked: true, shift: null }, to)).toBeNull();
    expect(timeIntoShift({ tracked: false }, to)).toBeNull();
  });

  it("keeps a duration short enough to sit inside another line", () => {
    expect(compactDuration(30 * 1000)).toBe("less than a minute");
    expect(compactDuration(42 * 60 * 1000)).toBe("42m");
    expect(compactDuration(60 * 60 * 1000)).toBe("1h");
    expect(compactDuration(72 * 60 * 1000)).toBe("1h 12m");
  });
});
