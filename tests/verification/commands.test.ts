import { describe, expect, it } from "vitest";
import { verificationStatusMessages } from "../../src/features/verification/discord/commands.js";
import type { VerificationStatus } from "../../src/features/verification/service/verification-service.js";

describe("verification status command", () => {
  it("shows reminder delivery and each member's warning and removal state", () => {
    const now = new Date("2026-08-11T12:00:00Z");
    const status: VerificationStatus = {
      lastReminderAt: new Date("2026-08-10T12:00:00Z"),
      nextReminderAt: new Date("2026-08-13T12:00:00Z"),
      staleTrackedCount: 1,
      members: [
        {
          discordUserId: "100",
          displayName: "Warned",
          firstSeenAt: new Date("2026-07-01T12:00:00Z"),
          warnedAt: new Date("2026-08-08T12:00:00Z"),
          finalWarningDueAt: new Date("2026-07-28T12:00:00Z"),
          removalDueAt: now,
        },
        {
          discordUserId: "200",
          displayName: "Waiting",
          firstSeenAt: new Date("2026-08-01T12:00:00Z"),
          warnedAt: null,
          finalWarningDueAt: new Date("2026-08-28T12:00:00Z"),
          removalDueAt: new Date("2026-08-31T12:00:00Z"),
        },
        {
          discordUserId: "300",
          displayName: "New",
          firstSeenAt: null,
          warnedAt: null,
          finalWarningDueAt: null,
          removalDueAt: null,
        },
      ],
    };

    const content = verificationStatusMessages(status, now).join("\n");
    expect(content).toContain("Role reminder message sent: yes");
    expect(content).toContain("<@100> — Final warning sent: yes");
    expect(content).toContain("removal due now");
    expect(content).toContain("<@200> — Final warning sent: no");
    expect(content).toContain("earliest removal");
    expect(content).toContain("<@300> — Final warning sent: no; not tracked yet");
    expect(content).toContain("Stored entries no longer holding the role: 1");
  });

  it("splits a large live list below Discord's message limit", () => {
    const status: VerificationStatus = {
      lastReminderAt: null,
      nextReminderAt: null,
      staleTrackedCount: 0,
      members: Array.from({ length: 100 }, (_, index) => ({
        discordUserId: String(100_000_000_000_000_000n + BigInt(index)),
        displayName: `Member ${index}`,
        firstSeenAt: new Date("2026-08-01T12:00:00Z"),
        warnedAt: null,
        finalWarningDueAt: new Date("2026-08-28T12:00:00Z"),
        removalDueAt: new Date("2026-08-31T12:00:00Z"),
      })),
    };

    const messages = verificationStatusMessages(status, new Date("2026-08-11T12:00:00Z"));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 2_000)).toBe(true);
    for (const member of status.members) expect(messages.join("\n")).toContain(`<@${member.discordUserId}>`);
  });
});
