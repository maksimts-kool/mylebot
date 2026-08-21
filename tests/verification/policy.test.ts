import { describe, expect, it } from "vitest";
import {
  finalWarningDueAt,
  kickDueAt,
  reminderIsDue,
  shouldKick,
  shouldSendFinalWarning,
  verificationDeadlineAt,
} from "../../src/features/verification/domain/policy.js";

describe("verification deadlines", () => {
  it("sends the final warning on day 27 of the 30-day period", () => {
    expect(finalWarningDueAt(new Date("2026-07-01T12:00:00Z")).toISOString())
      .toBe("2026-07-28T12:00:00.000Z");
    expect(verificationDeadlineAt(new Date("2026-07-01T12:00:00Z")).toISOString())
      .toBe("2026-07-31T12:00:00.000Z");
    expect(kickDueAt(new Date("2026-07-28T12:00:00Z")).toISOString())
      .toBe("2026-07-31T12:00:00.000Z");
  });

  it("warns after one month and never kicks before a delivered warning", () => {
    const now = new Date("2026-08-11T12:00:00Z");
    expect(shouldSendFinalWarning({
      discordUserId: "1",
      firstSeenAt: new Date("2026-07-15T12:00:00Z"),
      warnedAt: null,
    }, now)).toBe(true);
    expect(shouldKick({
      discordUserId: "1",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      warnedAt: null,
    }, now)).toBe(false);
  });

  it("waits a full three days after the final warning", () => {
    const record = {
      discordUserId: "1",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      warnedAt: new Date("2026-08-08T12:00:00Z"),
    };
    expect(shouldKick(record, new Date("2026-08-11T11:59:59Z"))).toBe(false);
    expect(shouldKick(record, new Date("2026-08-11T12:00:00Z"))).toBe(true);
  });

  it("keeps the reminder cadence across restarts", () => {
    expect(reminderIsDue(new Date("2026-08-08T12:00:00Z"), new Date("2026-08-11T11:59:59Z"))).toBe(false);
    expect(reminderIsDue(new Date("2026-08-08T12:00:00Z"), new Date("2026-08-11T12:00:00Z"))).toBe(true);
  });
});
