import type { CommandLogEntry } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { commandLogEmbed } from "../../src/features/command-logs/discord/command-log-embed.js";
import { riskColor } from "../../src/features/command-logs/domain/risk.js";

const occurredAt = new Date("2026-09-20T18:42:00Z");

function entry(overrides: Partial<CommandLogEntry> = {}): CommandLogEntry {
  return {
    id: "entry-1",
    eventId: "650daf2b-79b0-4d70-9c19-2a280fa3ac39",
    jobId: "8f3c1d2a-0000-0000-0000-00000000c4e1",
    placeId: 300n,
    robloxUserId: 999n,
    robloxUsername: "MaksimTs",
    rankNumber: 9,
    rankName: "Engineers Supervisor",
    adminLevel: 201,
    requiredLevel: 201,
    commandText: ":kick Kiryoku spamming the lift queue",
    commandName: "Kick",
    commandAlias: "kick",
    serverType: "PUBLIC",
    playerCount: 14,
    maxPlayers: 30,
    risk: "MEDIUM",
    targets: ["Kiryoku"],
    threadId: null,
    messageId: null,
    occurredAt,
    createdAt: occurredAt,
    ...overrides,
  } as CommandLogEntry;
}

function fieldNamed(embed: ReturnType<typeof commandLogEmbed>, name: string): string | undefined {
  return embed.toJSON().fields?.find((field) => field.name.includes(name))?.value;
}

describe("command log embed", () => {
  it("puts the command in the title and colours the embed by risk", () => {
    const json = commandLogEmbed(entry(), { discordUserId: "discord-1" }).toJSON();
    expect(json.title).toBe(":kick Kiryoku spamming the lift queue");
    expect(json.color).toBe(riskColor("MEDIUM"));
    expect(json.timestamp).toBe(occurredAt.toISOString());
  });

  it("names the staff member, their rank, the risk and who it hit", () => {
    const embed = commandLogEmbed(entry(), { discordUserId: "discord-1" });
    expect(fieldNamed(embed, "Staff")).toContain("MaksimTs");
    expect(fieldNamed(embed, "Staff")).toContain("<@discord-1>");
    expect(fieldNamed(embed, "Rank")).toContain("rank 9 · level 201");
    expect(fieldNamed(embed, "Risk")).toContain("requires 201");
    expect(fieldNamed(embed, "Ran on")).toBe("Kiryoku");
  });

  it("repeats nothing the server's panel already says", () => {
    const embed = commandLogEmbed(entry(), { discordUserId: null });
    const rendered = JSON.stringify(embed.toJSON());
    expect(fieldNamed(embed, "Server")).toBeUndefined();
    expect(fieldNamed(embed, "Job ID")).toBeUndefined();
    expect(rendered).not.toContain(entry().jobId);
    expect(rendered).not.toContain("14/30");
  });

  it("leaves out the Discord mention and the targets when there are none", () => {
    const embed = commandLogEmbed(entry({ targets: [] }), { discordUserId: null });
    expect(fieldNamed(embed, "Staff")).toBe("**MaksimTs**");
    expect(fieldNamed(embed, "Ran on")).toBeUndefined();
  });

  it("summarises a command run on more players than fit", () => {
    const targets = ["One", "Two", "Three", "Four", "Five", "Six"];
    const embed = commandLogEmbed(entry({ targets }), { discordUserId: null });
    expect(fieldNamed(embed, "Ran on")).toBe("One, Two, Three, Four and 2 more");
  });

  it("stays a plain record: the controls belong to the server's panel", () => {
    const json = commandLogEmbed(entry(), { discordUserId: null }).toJSON();
    expect(json.footer).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("cmdlog:");
  });
});
