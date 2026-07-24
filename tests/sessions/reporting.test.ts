import { describe, expect, it } from "vitest";
import { buildLeaderboard, tallinnDateRange } from "../../src/features/sessions/domain/reporting.js";

describe("reporting", () => {
  it("uses inclusive Tallinn dates and an exclusive next-day end across DST", () => {
    const spring = tallinnDateRange("2026-03-29", "2026-03-29", "Europe/Tallinn");
    expect(spring.start.toISOString()).toBe("2026-03-28T22:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-29T21:00:00.000Z");
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("sorts and filters by total elapsed time, including inactive time", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-02T00:00:00Z");
    const rows = buildLeaderboard([
      { identityId: "a", username: "Alpha", segments: [{ state: "ACTIVE", startedAt: start, endedAt: new Date(start.getTime() + 60_000) }] },
      { identityId: "b", username: "Beta", segments: [{ state: "INACTIVE", startedAt: start, endedAt: new Date(start.getTime() + 120_000) }] },
      { identityId: "c", username: "Cut", segments: [{ state: "ACTIVE", startedAt: start, endedAt: new Date(start.getTime() + 20_000) }] },
    ], start, end, 30_000);
    expect(rows.map((row) => row.username)).toEqual(["Beta", "Alpha"]);
  });
});

