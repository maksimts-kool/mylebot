import { describe, expect, it } from "vitest";
import { sessionDetailEmbed, type SessionDetail } from "../../src/features/sessions/discord/session-embed.js";
import type { CommandActivity } from "../../src/shared/staff-activity.js";

const startedAt = new Date("2026-09-20T18:00:00Z");
const endedAt = new Date("2026-09-20T20:00:00Z");

function session(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "session-1",
    state: "ENDED",
    startedAt,
    endedAt,
    jobId: "server-1",
    rankName: "Engineers Supervisor",
    segments: [{ state: "ACTIVE", startedAt, endedAt }],
    identity: { robloxUsername: "MaksimTs", discordUserId: "42" },
    ...overrides,
  };
}

function fieldNamed(detail: SessionDetail, name: string): string | undefined {
  return sessionDetailEmbed(detail, endedAt).toJSON().fields?.find((field) => field.name.includes(name))?.value;
}

const commands: CommandActivity = {
  total: 5,
  highestRisk: "HIGH",
  byRisk: [{ risk: "HIGH", count: 1 }, { risk: "MEDIUM", count: 4 }],
  top: [{ name: "Kick", count: 4 }, { name: "Ban", count: 1 }],
};

describe("the full picture of one session", () => {
  it("says what was run during the shift and how bad the worst of it was", () => {
    const value = fieldNamed(session({ commands }), "Commands");
    expect(value).toContain("5 run");
    expect(value).toContain("High");
    expect(value).toContain("Kick ×4 · Ban ×1");
  });

  it("says nothing about commands for a shift the command log has no records for", () => {
    expect(fieldNamed(session(), "Commands")).toBeUndefined();
    expect(fieldNamed(session({ commands: { total: 0, highestRisk: null, byRisk: [], top: [] } }), "Commands")).toBeUndefined();
  });
});
