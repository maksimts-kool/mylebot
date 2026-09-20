import type { CommandLogThread } from "@prisma/client";
import { ButtonStyle, ComponentType } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  PANEL_ACTIONS, accessNotice, parsePanelCustomId, serverPanelComponents, serverPanelEmbed, threadName,
} from "../../src/features/command-logs/discord/server-panel.js";
import type { StoredStaff } from "../../src/features/command-logs/domain/roster.js";

const lastSeenAt = new Date("2026-09-20T18:42:00Z");
const blockedUntil = new Date("2026-09-20T18:57:00Z");

function server(overrides: Partial<CommandLogThread> = {}): CommandLogThread {
  return {
    jobId: "8f3c1d2a-0000-0000-0000-00000000c4e1",
    channelId: "channel-1",
    threadId: "thread-1",
    panelMessageId: "panel-1",
    placeId: 300n,
    serverType: "PUBLIC",
    playerCount: 14,
    maxPlayers: 30,
    staff: [],
    lastSeenAt,
    closedAt: null,
    createdAt: lastSeenAt,
    lastPostedAt: lastSeenAt,
    ...overrides,
  } as CommandLogThread;
}

const staff: StoredStaff[] = [
  { userId: "999", username: "MaksimTs", rankNumber: 9, rankName: "Engineers Supervisor", adminLevel: 201 },
  { userId: "1000", username: "Kiryoku", rankNumber: 7, rankName: "Lift Engineer", adminLevel: 101 },
];

function rowsOf(rows: ReturnType<typeof serverPanelComponents>) {
  return rows.map((row) => row.components.map((component) => component.toJSON()));
}

describe("the server panel", () => {
  it("reports the population, the place and everybody who can run commands", () => {
    const json = serverPanelEmbed(server(), staff, new Map()).toJSON();
    expect(json.title).toContain("Public server");
    expect(json.description).toContain("14/30 players");
    expect(json.description).toContain(server().jobId);
    const field = json.fields?.[0];
    expect(field?.name).toContain("(2)");
    expect(field?.value).toContain("**MaksimTs** — Supervisors");
    expect(field?.value).toContain("**Kiryoku** — Engineers");
  });

  it("marks who currently has no command access, and until when", () => {
    const json = serverPanelEmbed(server(), staff, new Map([["999", blockedUntil]])).toJSON();
    expect(json.fields?.[0]?.value).toContain(`🔒 **MaksimTs**`);
    expect(json.fields?.[0]?.value).toContain(`<t:${Math.floor(blockedUntil.getTime() / 1000)}:t>`);
  });

  it("shows the Adonis tier alone when the group rank is unknown", () => {
    const unknown: StoredStaff[] = [
      { userId: "999", username: "1MaksimTs", rankNumber: 0, rankName: "", adminLevel: 1000 },
    ];
    const json = serverPanelEmbed(server(), unknown, new Map()).toJSON();
    // Never "Creators · Not in group": a failed lookup is not a rank name.
    expect(json.fields?.[0]?.value).toBe("**1MaksimTs** — Creators");

    const menu = serverPanelComponents(server(), unknown, new Map())[1]!.components[0]!.toJSON();
    expect("options" in menu && menu.options?.[0]?.description).toBe("Creators");
  });

  it("says so plainly when no staff are in the server", () => {
    const json = serverPanelEmbed(server(), [], new Map()).toJSON();
    expect(json.fields?.[0]?.value).toBe("Nobody with Adonis access is in this server.");
  });

  it("offers a way in and a picker for each direction access can move", () => {
    const rows = rowsOf(serverPanelComponents(server(), staff, new Map([["999", blockedUntil]])));
    expect(rows[0]?.[0]).toMatchObject({ style: ButtonStyle.Link, label: "Join server" });
    expect("url" in rows[0]![0]! && rows[0]![0]!.url).toContain("gameInstanceId=8f3c1d2a");

    const [disable, restore] = [rows[1]?.[0], rows[2]?.[0]];
    expect(disable).toMatchObject({ type: ComponentType.StringSelect, custom_id: "cmdlog:disable" });
    expect(restore).toMatchObject({ type: ComponentType.StringSelect, custom_id: "cmdlog:restore" });
    // Each menu offers only the people it can actually act on.
    expect("options" in disable! && disable.options?.map((option) => option.value)).toEqual(["1000"]);
    expect("options" in restore! && restore.options?.map((option) => option.value)).toEqual(["999"]);
  });

  it("leaves off a menu that would have nobody to offer", () => {
    const rows = rowsOf(serverPanelComponents(server(), staff, new Map()));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toMatchObject({ custom_id: "cmdlog:disable" });
  });

  it("has nothing to join in Studio", () => {
    const rows = rowsOf(serverPanelComponents(server({ serverType: "STUDIO" }), staff, new Map()));
    expect(rows[0]?.[0]).toMatchObject({ custom_id: "cmdlog:disable" });
  });

  it("stops offering anything once the server has closed", () => {
    const closedAt = new Date("2026-09-20T19:00:00Z");
    const closed = server({ closedAt });
    const json = serverPanelEmbed(closed, staff, new Map()).toJSON();
    expect(json.description).toContain("closed");
    expect(json.fields).toBeUndefined();
    expect(serverPanelComponents(closed, staff, new Map())).toHaveLength(0);
  });

  it("owns only its own custom ids", () => {
    expect(parsePanelCustomId("cmdlog:disable")).toBe(PANEL_ACTIONS.disable);
    expect(parsePanelCustomId("cmdlog:restore")).toBe(PANEL_ACTIONS.restore);
    expect(parsePanelCustomId("refresh:session-1")).toBeNull();
  });

  it("names a thread after the server it logs", () => {
    expect(threadName(server())).toBe(`Server ${server().jobId}`);
    expect(threadName(server({ serverType: "STUDIO" }))).toContain("Studio");
  });

  it("leaves a readable line in the thread whenever access moves", () => {
    expect(accessNotice("disabled", "MaksimTs", "<@presser>", blockedUntil)).toContain("disabled **MaksimTs**");
    expect(accessNotice("restored", "MaksimTs", "<@presser>")).toContain("gave **MaksimTs**");
  });
});
