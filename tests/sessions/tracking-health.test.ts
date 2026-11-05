import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  SWEEP_GRACE_MS, channelProblem, trackingConfigSection, trackingProblems,
} from "../../src/features/sessions/discord/config-section.js";
import { sessionsServerPort } from "../../src/features/sessions/service/sessions-port.js";

function clientWith(channels: Record<string, object>, ready = true) {
  return {
    isReady: () => ready,
    user: { id: "bot" },
    channels: { cache: { get: (id: string) => channels[id] } },
  };
}

function textChannel(granted: bigint[]) {
  return {
    isDMBased: () => false,
    isTextBased: () => true,
    permissionsFor: () => ({ has: (flag: bigint) => granted.includes(flag) }),
  };
}

const ALL = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
];

describe("session tracking health", () => {
  it("reports nothing when the logs channel is set and the sweep keeps up", () => {
    expect(trackingProblems({ trackingEnabled: true, logsChannelId: "1", overdueSessions: 0, channelProblems: [] })).toEqual([]);
  });

  it("flags a missing logs channel, unreachable channels, and sessions the sweep left open", () => {
    const problems = trackingProblems({
      trackingEnabled: true, logsChannelId: "", overdueSessions: 2, channelProblems: ["Staff chat channel is missing: Embed Links."],
    });
    expect(problems).toEqual([
      "No logs channel set — shifts are not published.",
      "Staff chat channel is missing: Embed Links.",
      "2 live sessions are past the heartbeat deadline — the sweep is not closing them.",
    ]);
  });

  it("does not blame the sweep while tracking is switched off, because it stands down on purpose", () => {
    expect(trackingProblems({ trackingEnabled: false, logsChannelId: "1", overdueSessions: 3, channelProblems: [] })).toEqual([]);
  });

  it("checks the bot can post, embed, and find its messages in a configured channel", () => {
    expect(channelProblem(clientWith({ 1: textChannel(ALL) }) as never, "1", "Logs channel")).toBeNull();
    expect(channelProblem(clientWith({ 1: textChannel([PermissionFlagsBits.ViewChannel]) }) as never, "1", "Logs channel"))
      .toBe("Logs channel is missing: Send Messages, Embed Links, Read Message History.");
    expect(channelProblem(clientWith({}) as never, "9", "Logs channel")).toBe("Logs channel no longer exists, or the bot cannot see it.");
  });

  it("says nothing about an unset channel, or before the gateway is ready to judge", () => {
    expect(channelProblem(clientWith({}) as never, "", "Staff chat channel")).toBeNull();
    expect(channelProblem(clientWith({}, false) as never, "9", "Logs channel")).toBeNull();
  });

  it("counts live sessions past the heartbeat deadline plus the sweep's grace", async () => {
    const count = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const db = { session: { count }, processedEvent: { findFirst: vi.fn().mockResolvedValue({ receivedAt: new Date("2026-11-04T12:00:00Z") }) } };
    const settings = { get: vi.fn().mockResolvedValue({ trackingEnabled: true, logsChannelId: "1", staffChannelId: "" }) };
    // The counts come from the server half; the channel check is the bot's own.
    const sessions = sessionsServerPort({
      db: db as never, config: { HEARTBEAT_STALE_SECONDS: 75 } as never, settings: settings as never,
      bloxlink: {} as never, badges: {} as never, publisher: {} as never,
    });
    const section = trackingConfigSection(clientWith({ 1: textChannel(ALL) }) as never, sessions);

    const before = Date.now();
    const fields = (await section.view()).embeds[0]!.toJSON().fields ?? [];
    const after = Date.now();
    const cutoff = (count.mock.calls[1]![0] as { where: { lastEventAt: { lt: Date } } }).where.lastEventAt.lt.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - 75_000 - SWEEP_GRACE_MS);
    expect(cutoff).toBeLessThanOrEqual(after - 75_000 - SWEEP_GRACE_MS);

    expect(fields.find((field) => field.name === "Live sessions")?.value).toBe("**4**");
    expect(fields.find((field) => field.name === "Last Roblox event")?.value).toBe("<t:1793793600:R>");
    expect(fields.find((field) => field.name === "Health")?.value).toContain("1 live session is past the heartbeat deadline");
  });
});
