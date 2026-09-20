import type { CommandLogEntry } from "@prisma/client";
import { ButtonStyle } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  commandLogComponents, commandLogEmbed, disableRequirement, parseCommandLogCustomId, restoreRequirement,
} from "../../src/features/command-logs/discord/command-log-embed.js";
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
    const embed = commandLogEmbed(entry(), { discordUserId: "discord-1" });
    const json = embed.toJSON();
    expect(json.title).toBe(":kick Kiryoku spamming the lift queue");
    expect(json.color).toBe(riskColor("MEDIUM"));
    expect(json.timestamp).toBe(occurredAt.toISOString());
  });

  it("names the staff member, their rank, the risk, the server and the job", () => {
    const embed = commandLogEmbed(entry(), { discordUserId: "discord-1" });
    expect(fieldNamed(embed, "Staff")).toContain("MaksimTs");
    expect(fieldNamed(embed, "Staff")).toContain("<@discord-1>");
    expect(fieldNamed(embed, "Rank")).toContain("rank 9 · level 201");
    expect(fieldNamed(embed, "Risk")).toContain("requires 201");
    expect(fieldNamed(embed, "Server")).toContain("Public · 14/30");
    expect(fieldNamed(embed, "Ran on")).toBe("Kiryoku");
    expect(fieldNamed(embed, "Job ID")).toContain(entry().jobId);
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

  it("says a Studio playtest is one, because there is no server to report", () => {
    const embed = commandLogEmbed(entry({ serverType: "STUDIO" }), { discordUserId: null });
    expect(fieldNamed(embed, "Server")).toContain("Studio");
  });

  it("keeps a lifted block in the record, naming who gave access back", () => {
    const embed = commandLogEmbed(entry(), { discordUserId: null, restoredBy: "<@presser>" });
    expect(fieldNamed(embed, "Command access")).toBe("Disabled, then given back by <@presser>");
  });

  it("shows the block and when access comes back once somebody presses", () => {
    const blockedUntil = new Date("2026-09-20T18:57:00Z");
    const embed = commandLogEmbed(entry(), { discordUserId: null, blockedUntil, blockedBy: "<@presser>" });
    const value = fieldNamed(embed, "Command access");
    expect(value).toContain(`<t:${Math.floor(blockedUntil.getTime() / 1000)}:f>`);
    expect(value).toContain("<@presser>");
  });
});

describe("command log buttons", () => {
  function labelled(components: ReturnType<typeof commandLogComponents>) {
    return components[0]!.components.map((component) => component.toJSON());
  }

  it("offers a link straight into that server, and the disable button", () => {
    const buttons = labelled(commandLogComponents(entry(), { discordUserId: null }));
    expect(buttons[0]).toMatchObject({ style: ButtonStyle.Link, label: "Join server" });
    expect("url" in buttons[0]! && buttons[0].url).toContain("gameInstanceId=8f3c1d2a");
    expect(buttons[1]).toMatchObject({ style: ButtonStyle.Danger, label: "Disable access 15m" });
  });

  it("has nothing to join in Studio", () => {
    const buttons = labelled(commandLogComponents(entry({ serverType: "STUDIO" }), { discordUserId: null }));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ label: "Disable access 15m" });
  });

  it("offers the way out instead of a second disable while a block is on", () => {
    const buttons = labelled(commandLogComponents(entry(), { discordUserId: null, blockedUntil: new Date() }));
    expect(buttons.map((button) => "label" in button && button.label)).toEqual(["Join server", "Restore access"]);
    expect(buttons[1]).toMatchObject({ style: ButtonStyle.Success, custom_id: "cmdlog:restore:entry-1" });
  });

  it("offers disabling again once access has been given back", () => {
    const buttons = labelled(commandLogComponents(entry(), { discordUserId: null, restoredBy: "<@presser>" }));
    expect(buttons[1]).toMatchObject({ label: "Disable access 15m", custom_id: "cmdlog:disable:entry-1" });
  });

  it("owns only its own custom ids", () => {
    expect(parseCommandLogCustomId("cmdlog:disable:entry-1")).toEqual({ action: "disable", entryId: "entry-1" });
    expect(parseCommandLogCustomId("refresh:session-1")).toBeNull();
    expect(parseCommandLogCustomId("cmdlog:disable")).toBeNull();
  });

  it("explains what pressing requires, in tier names staff recognise", () => {
    expect(disableRequirement(entry())).toContain("Managers");
    expect(disableRequirement(entry({ adminLevel: 101 }))).toContain("Supervisors");
    // Giving access back overrules another staff member, so it is Managers
    // whatever tier the run itself was.
    expect(restoreRequirement()).toContain("Managers");
  });
});

describe("what the embed leaves out", () => {
  it("keeps the footer to the time it ran", () => {
    const json = commandLogEmbed(entry(), { discordUserId: null }).toJSON();
    expect(json.footer).toBeUndefined();
    expect(json.timestamp).toBe(occurredAt.toISOString());
  });
});
