import { describe, expect, it } from "vitest";
import { verificationStatusEmbeds } from "../../src/features/verification/discord/commands.js";
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
          discordUserId: "1485701483038118059",
          displayName: "Maksim",
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

    const embeds = verificationStatusEmbeds(status, now).map((embed) => embed.toJSON());
    const content = JSON.stringify(embeds);
    expect(embeds[0]?.title).toBe("🔐 Verification Timeout Dashboard");
    expect(embeds[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "👥 Unverified", value: "**3**" }),
      expect.objectContaining({ name: "🚨 Removal due", value: "**1**" }),
      expect.objectContaining({ name: "📨 Role reminder", value: expect.stringContaining("✅ Last sent") }),
      expect.objectContaining({ name: "🧹 Pending cleanup", value: expect.stringContaining("**1** stored entry") }),
    ]));
    expect(content).toContain("🚨 Removal due");
    expect(content).toContain("**Member:** [@Warned](https://discord.com/users/100)");
    expect(content).toContain("**Final warning:** ✅ Sent");
    expect(content).toContain("⏳ Waiting");
    expect(content).toContain("**Member:** [@Maksim](https://discord.com/users/1485701483038118059)");
    expect(content).not.toContain("<@1485701483038118059>");
    expect(content).toContain("**Earliest removal:**");
    expect(content).toContain("🆕 New");
    expect(content).toContain("**Member:** [@New](https://discord.com/users/300)");
    expect(content).toContain("**Removal:** No deadline yet");
    const waitingField = embeds[1]?.fields?.find((field) => field.name === "⏳ Waiting");
    expect(waitingField?.name).not.toMatch(/[\[\]{}]/);
    expect(waitingField?.value).toContain("[@Maksim](https://discord.com/users/1485701483038118059)");
  });

  it("paginates a large live list within Discord's embed limits", () => {
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

    const embeds = verificationStatusEmbeds(status, new Date("2026-08-11T12:00:00Z"));
    expect(embeds).toHaveLength(6);
    const data = embeds.map((embed) => embed.toJSON());
    for (const page of data.slice(1)) {
      expect(page.fields?.length).toBeLessThanOrEqual(20);
      const characterCount = (page.title?.length ?? 0)
        + (page.description?.length ?? 0)
        + (page.footer?.text.length ?? 0)
        + (page.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
      expect(characterCount).toBeLessThanOrEqual(6_000);
    }
    const content = JSON.stringify(data);
    for (const member of status.members) {
      expect(content).toContain(`**Member:** [@${member.displayName}](https://discord.com/users/${member.discordUserId})`);
      expect(content).not.toContain(`<@${member.discordUserId}>`);
    }
  });
});
