import { describe, expect, it } from "vitest";
import { assertDurationInvariant, overlapMilliseconds, totalsForPeriod } from "../src/domain/accounting.js";

describe("session accounting", () => {
  it("counts only the exact overlap and treats reconnecting as inactive", () => {
    const segments = [
      { state: "ACTIVE" as const, startedAt: new Date("2026-01-01T00:00:00Z"), endedAt: new Date("2026-01-01T01:00:00Z") },
      { state: "RECONNECTING" as const, startedAt: new Date("2026-01-01T01:00:00Z"), endedAt: new Date("2026-01-01T01:02:00Z") },
      { state: "INACTIVE" as const, startedAt: new Date("2026-01-01T01:02:00Z"), endedAt: new Date("2026-01-01T02:00:00Z") },
    ];
    expect(totalsForPeriod(segments, new Date("2026-01-01T00:30:00Z"), new Date("2026-01-01T01:30:00Z"))).toEqual({
      activeMs: 30 * 60_000, inactiveMs: 30 * 60_000, totalMs: 60 * 60_000,
    });
  });

  it("returns zero for touching and disjoint ranges", () => {
    const start = new Date("2026-01-02T00:00:00Z");
    const end = new Date("2026-01-03T00:00:00Z");
    expect(overlapMilliseconds(start, end, new Date("2026-01-01T00:00:00Z"), start)).toBe(0);
  });

  it("enforces manual duration invariants", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T01:00:00Z");
    expect(() => assertDurationInvariant(start, end, 3_000_000, 600_000)).not.toThrow();
    expect(() => assertDurationInvariant(start, end, 3_000_000, 500_000)).toThrow(/must equal/);
  });
});

