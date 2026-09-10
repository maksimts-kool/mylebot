import { describe, expect, it, vi } from "vitest";
import { buildAnnouncementActionRow, buildSessionActionRow, DiscordPublisher } from "../../src/features/sessions/discord/publisher.js";

function labelsOf(row: ReturnType<typeof buildSessionActionRow>): string[] {
  return row.components.map((component) => {
    const data = component.toJSON();
    return "label" in data ? data.label : "";
  });
}

function labelsFor(state: "ACTIVE" | "ENDED"): string[] {
  return labelsOf(buildSessionActionRow({
    id: "session-1",
    identityId: "identity-1",
    state,
    placeId: "123",
    jobId: "server-1",
  }));
}

const startedAt = new Date("2026-01-01T00:00:00Z");

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
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
    announcement: null,
    ...overrides,
  };
}

/** A publisher wired to in-memory channels, one per configured channel id. */
function publisherFor(session: Record<string, unknown>, settings: Record<string, string>) {
  const channels = new Map<string, {
    id: string;
    send: ReturnType<typeof vi.fn>;
    messages: { fetch: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  }>();
  const edits = new Map<string, ReturnType<typeof vi.fn>>();
  const channelFor = (channelId: string) => {
    const existing = channels.get(channelId);
    if (existing) return existing;
    const created = {
      id: channelId,
      send: vi.fn().mockResolvedValue({ id: `${channelId}-message` }),
      messages: {
        fetch: vi.fn(async (messageId: string) => {
          if (!edits.has(messageId)) edits.set(messageId, vi.fn());
          return { edit: edits.get(messageId)! };
        }),
        delete: vi.fn(),
      },
    };
    channels.set(channelId, created);
    return created;
  };
  const client = {
    isReady: vi.fn().mockReturnValue(true),
    channels: { fetch: vi.fn(async (channelId: string) => channelFor(channelId)) },
  };
  const db = {
    session: { findUnique: vi.fn().mockResolvedValue(session), findMany: vi.fn().mockResolvedValue([]) },
    discordMessage: { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
    sessionAnnouncement: { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
  };
  const publisher = new DiscordPublisher(
    client as never,
    db as never,
    { REPORT_TIMEZONE: "Europe/Tallinn" } as never,
    { discordForRoblox: vi.fn() } as never,
    { get: vi.fn().mockResolvedValue({ trackingEnabled: true, logsChannelId: "", staffChannelId: "", ...settings }) } as never,
  );
  return {
    publisher,
    db,
    channels,
    /** What a message was edited to, or undefined when it was never edited. */
    editsTo: (messageId: string) => edits.get(messageId),
  };
}

describe("session message controls", () => {
  it("offers joining and refresh on the log message while a session is live", () => {
    expect(labelsFor("ACTIVE")).toEqual(["Join Server", "View History", "Refresh"]);
  });

  it("drops joining and refresh from the log message after a session ends", () => {
    expect(labelsFor("ENDED")).toEqual(["View History"]);
  });

  it("gives the staff announcement a single details button", () => {
    expect(labelsOf(buildAnnouncementActionRow("session-1"))).toEqual(["More info"]);
  });
});

describe("session log message", () => {
  it("keeps the full record and carries no mention of its own", async () => {
    const { publisher, channels } = publisherFor(liveSession(), { logsChannelId: "logs" });

    await publisher.refresh("session-1");

    const payload = channels.get("logs")!.send.mock.calls[0]![0] as {
      content: string;
      embeds: Array<{ toJSON(): { title?: string; fields?: Array<{ name: string }> } }>;
    };
    expect(payload.content).toBe("");
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.title).toBe("Staff session · session-1");
    expect(embed.fields?.map((field) => field.name)).toContain("Total time");
  });

  it("is not published at all when only the staff channel is configured", async () => {
    const { publisher, channels, db } = publisherFor(liveSession(), { staffChannelId: "staff" });

    await publisher.refresh("session-1");

    expect(channels.has("logs")).toBe(false);
    expect(db.discordMessage.upsert).not.toHaveBeenCalled();
    expect(channels.get("staff")!.send).toHaveBeenCalled();
  });
});

describe("staff chat announcement", () => {
  it("announces the start with the mention outside the embed", async () => {
    const { publisher, db, channels } = publisherFor(liveSession(), { logsChannelId: "logs", staffChannelId: "staff" });

    await publisher.refresh("session-1");

    const payload = channels.get("staff")!.send.mock.calls[0]![0] as {
      content: string;
      embeds: Array<{ toJSON(): { title?: string; description?: string } }>;
    };
    expect(payload.content).toBe("<@42>");
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.title).toBe("🟢 Session started");
    expect(embed.description).toContain("Tester");
    expect(db.sessionAnnouncement.upsert).toHaveBeenCalled();
  });

  it("leaves the announcement untouched while the shift is still running", async () => {
    const session = liveSession({ state: "INACTIVE", announcement: { channelId: "staff", messageId: "announcement-1" } });
    const { publisher, channels, editsTo } = publisherFor(session, { staffChannelId: "staff" });

    await publisher.refresh("session-1");

    expect(channels.has("staff")).toBe(false);
    expect(editsTo("announcement-1")).toBeUndefined();
  });

  it("edits the same message when the shift ends", async () => {
    const endedAt = new Date("2026-01-01T02:00:00Z");
    const session = liveSession({
      state: "ENDED",
      endedAt,
      lastEventAt: endedAt,
      segments: [{ state: "ACTIVE", startedAt, endedAt }],
      announcement: { channelId: "staff", messageId: "announcement-1" },
    });
    const { publisher, db, channels, editsTo } = publisherFor(session, { staffChannelId: "staff" });

    await publisher.refresh("session-1");

    const edit = editsTo("announcement-1");
    expect(edit).toBeDefined();
    const payload = edit!.mock.calls[0]![0] as { embeds: Array<{ toJSON(): { title?: string } }> };
    expect(payload.embeds[0]!.toJSON().title).toBe("✅ Session ended");
    // Editing in place must not post a second announcement or store a new one.
    expect(channels.get("staff")!.send).not.toHaveBeenCalled();
    expect(db.sessionAnnouncement.upsert).not.toHaveBeenCalled();
  });

  it("removes both messages when a completed record is shorter than one minute", async () => {
    const endedAt = new Date("2026-01-01T00:00:30Z");
    const session = liveSession({
      state: "ENDED",
      endedAt,
      segments: [{ state: "ACTIVE", startedAt, endedAt }],
      discordMessage: { channelId: "logs", messageId: "log-1" },
      announcement: { channelId: "staff", messageId: "announcement-1" },
    });
    const { publisher, db, channels } = publisherFor(session, { logsChannelId: "logs", staffChannelId: "staff" });

    await publisher.refresh("session-1");

    expect(channels.get("logs")!.messages.delete).toHaveBeenCalledWith("log-1");
    expect(channels.get("staff")!.messages.delete).toHaveBeenCalledWith("announcement-1");
    expect(db.discordMessage.deleteMany).toHaveBeenCalledWith({ where: { sessionId: "session-1" } });
    expect(db.sessionAnnouncement.deleteMany).toHaveBeenCalledWith({ where: { sessionId: "session-1" } });
  });
});
