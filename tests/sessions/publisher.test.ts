import { describe, expect, it, vi } from "vitest";
import { buildSessionActionRow, DiscordPublisher } from "../../src/features/sessions/discord/publisher.js";

function labelsFor(state: "ACTIVE" | "ENDED"): string[] {
  return buildSessionActionRow({
    id: "session-1",
    identityId: "identity-1",
    state,
    placeId: "123",
    jobId: "server-1",
  }).components.map((component) => {
    const data = component.toJSON();
    return "label" in data ? data.label : "";
  });
}

describe("session message controls", () => {
  it("offers the details button, joining, and refresh while a session is live", () => {
    expect(labelsFor("ACTIVE")).toEqual(["More info", "Join Server", "View History", "Refresh"]);
  });

  it("keeps the details button but drops joining and refresh after a session ends", () => {
    expect(labelsFor("ENDED")).toEqual(["More info", "View History"]);
  });

  it("removes the published message when a completed record is shorter than one minute", async () => {
    const deleteMessage = vi.fn();
    const deleteReference = vi.fn();
    const client = {
      isReady: vi.fn().mockReturnValue(true),
      channels: { fetch: vi.fn().mockResolvedValue({ messages: { delete: deleteMessage } }) },
    };
    const db = {
      session: { findUnique: vi.fn().mockResolvedValue({
        id: "session-1",
        state: "ENDED",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        endedAt: new Date("2026-01-01T00:00:30Z"),
        segments: [{ state: "ACTIVE", startedAt: new Date("2026-01-01T00:00:00Z"), endedAt: new Date("2026-01-01T00:00:30Z") }],
        discordMessage: { channelId: "channel-1", messageId: "message-1" },
      }) },
      discordMessage: { deleteMany: deleteReference },
    };
    const publisher = new DiscordPublisher(
      client as never,
      db as never,
      {} as never,
      {} as never,
      { get: vi.fn().mockResolvedValue({ logsChannelId: "channel-1" }) } as never,
    );

    await publisher.refresh("session-1");

    expect(deleteMessage).toHaveBeenCalledWith("message-1");
    expect(deleteReference).toHaveBeenCalledWith({ where: { sessionId: "session-1" } });
  });

  it("announces a started session with the mention outside the embed", async () => {
    const send = vi.fn().mockResolvedValue({ id: "message-1" });
    const client = {
      isReady: vi.fn().mockReturnValue(true),
      channels: { fetch: vi.fn().mockResolvedValue({ id: "channel-1", send }) },
    };
    const startedAt = new Date("2026-01-01T00:00:00Z");
    const db = {
      session: { findUnique: vi.fn().mockResolvedValue({
        id: "session-1",
        identityId: "identity-1",
        state: "ACTIVE",
        startedAt,
        endedAt: null,
        lastEventAt: startedAt,
        deletedAt: null,
        rankName: "Moderator",
        placeId: 300n,
        jobId: "server-1",
        segments: [{ state: "ACTIVE", startedAt, endedAt: null }],
        identity: { robloxUserId: 1n, robloxUsername: "Tester", discordUserId: "42" },
        discordMessage: null,
      }) },
      discordMessage: { create: vi.fn() },
    };
    const publisher = new DiscordPublisher(
      client as never,
      db as never,
      {} as never,
      { discordForRoblox: vi.fn() } as never,
      { get: vi.fn().mockResolvedValue({ logsChannelId: "channel-1" }) } as never,
    );

    await publisher.refresh("session-1");

    const payload = send.mock.calls[0]![0] as { content: string; embeds: Array<{ toJSON(): { title?: string; fields?: Array<{ name: string }> } }> };
    expect(payload.content).toBe("<@42>");
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.title).toBe("🟢 Session started");
    // The running totals live behind the details button, not in the channel.
    expect(embed.fields?.map((field) => field.name)).not.toContain("Total time");
    expect(db.discordMessage.create).toHaveBeenCalled();
  });
});
