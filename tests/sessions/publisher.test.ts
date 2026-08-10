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
  it("offers refresh while a session is live", () => {
    expect(labelsFor("ACTIVE")).toEqual(["Join Server", "View History", "Refresh"]);
  });

  it("removes refresh after a session ends", () => {
    expect(labelsFor("ENDED")).toEqual(["View History"]);
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
});
