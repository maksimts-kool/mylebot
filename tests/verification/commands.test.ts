import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  VERIFICATION_CLOSE_ID, VerificationCommandHandler, verificationStatusEmbeds,
} from "../../src/features/verification/discord/commands.js";
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

describe("verification status close button", () => {
  function manager() {
    return { permissions: String(PermissionFlagsBits.Administrator), roles: [] };
  }

  async function runStatus(memberCount: number) {
    let listener: (interaction: unknown) => void = () => undefined;
    const client = { on: (_event: string, handler: typeof listener) => { listener = handler; } };
    const service = {
      status: vi.fn().mockResolvedValue({
        lastReminderAt: null,
        nextReminderAt: null,
        staleTrackedCount: 0,
        members: Array.from({ length: memberCount }, (_, index) => ({
          discordUserId: String(100 + index),
          displayName: `Member ${index}`,
          firstSeenAt: null,
          warnedAt: null,
          finalWarningDueAt: null,
          removalDueAt: null,
        })),
      } satisfies VerificationStatus),
    };
    new VerificationCommandHandler(client as never, {} as never, { DISCORD_GUILD_ID: "guild" } as never, service as never).register();

    const sent: Array<{ id: string; components: unknown[] }> = [];
    let next = 0;
    const record = (body: { components: unknown[] }) => {
      const message = { id: `m${next++}`, components: body.components };
      sent.push(message);
      return Promise.resolve(message);
    };
    const command = {
      isButton: () => false,
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: "verification",
      guildId: "guild",
      member: manager(),
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn(record),
      followUp: vi.fn(record),
      deleteReply: vi.fn().mockResolvedValue(undefined),
    };
    listener(command);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    await new Promise((resolve) => setImmediate(resolve));

    const close = (messageId: string) => {
      const button = {
        isButton: () => true,
        isRepliable: () => true,
        customId: VERIFICATION_CLOSE_ID,
        message: { id: messageId },
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        deleteReply: vi.fn().mockResolvedValue(undefined),
      };
      listener(button);
      return button;
    };
    return { sent, command, close };
  }

  function hasClose(message: { components: unknown[] }): boolean {
    return JSON.stringify(message.components).includes(VERIFICATION_CLOSE_ID);
  }

  it("puts the close button under the last message only", async () => {
    const { sent } = await runStatus(45);
    expect(sent).toHaveLength(4);
    expect(sent.slice(0, -1).some(hasClose)).toBe(false);
    expect(hasClose(sent.at(-1)!)).toBe(true);
  });

  it("puts it on the only message when nobody is unverified", async () => {
    const { sent } = await runStatus(0);
    expect(sent).toHaveLength(1);
    expect(hasClose(sent[0]!)).toBe(true);
  });

  it("takes the whole dashboard down when closed", async () => {
    const { sent, command, close } = await runStatus(45);
    const button = close(sent.at(-1)!.id);
    await vi.waitFor(() => expect(button.deleteReply).toHaveBeenCalledWith(sent.at(-1)!.id));
    // The original reply, then each follow-up above the button.
    expect(command.deleteReply).toHaveBeenCalledWith();
    expect(command.deleteReply).toHaveBeenCalledWith("m1");
    expect(command.deleteReply).toHaveBeenCalledWith("m2");
    expect(command.deleteReply).toHaveBeenCalledTimes(3);
  });
});
