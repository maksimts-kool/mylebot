import { describe, expect, it } from "vitest";
import { UserFacingError } from "../../src/core/errors.js";
import { createLogger } from "../../src/core/logger.js";
import { InteractionLog, commandOptions, interactionName } from "../../src/shared/discord/interaction-log.js";

/** Only the type guards an interaction answers `true` to need saying. */
function fake(kind: "command" | "button" | "select" | "modal", extra: Record<string, unknown> = {}) {
  return {
    isChatInputCommand: () => kind === "command",
    isCommand: () => kind === "command",
    isButton: () => kind === "button",
    isAnySelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    user: { username: "zdenek99000" },
    ...extra,
  } as never;
}

function command(name: string, subcommand: string | null, data: unknown[] = []) {
  return fake("command", {
    commandName: name,
    options: { getSubcommandGroup: () => null, getSubcommand: () => subcommand, data },
  });
}

function collecting() {
  const lines: Array<Record<string, unknown> & { level: string; msg: string }> = [];
  const log = createLogger({ service: "bot", level: "debug", format: "json", write: (line) => lines.push(JSON.parse(line)) });
  return { log, lines };
}

describe("naming an interaction", () => {
  it("names a slash command with its subcommand", () => {
    expect(interactionName(command("profile", null))).toBe("/profile");
    expect(interactionName(command("session", "view"))).toBe("/session view");
  });

  it("names a component by what the person clicking it saw", () => {
    expect(interactionName(fake("button", { customId: "leaderboard:a:b:0:1", component: { label: "Next" } }))).toBe("Next button");
    // A placeholder's leading emoji is decoration, not a name.
    expect(interactionName(fake("select", {
      customId: "leaderboard-user", component: { placeholder: "👤 View a user's session history" },
    }))).toBe("View a user's session history menu");
    expect(interactionName(fake("modal", { customId: "editended:clx1" }))).toBe("form");
  });

  it("falls back to the custom id's first segment when a component has no label", () => {
    expect(interactionName(fake("button", { customId: "refresh:clx1", component: {} }))).toBe("refresh button");
  });

  it("logs the options a command ran with by name, never a raw user id", () => {
    const options = [{ name: "user", value: "1485701483038118059", user: { username: "wolfik11111111" } }];
    expect(commandOptions(command("profile", null, options))).toEqual({ user: "wolfik11111111" });
    const nested = [{ name: "active", options: [{ name: "user", value: "1", user: { username: "wolfik" } }] }];
    expect(commandOptions(command("session", "active", nested))).toEqual({ user: "wolfik" });
  });
});

describe("the line an interaction leaves", () => {
  it("says what the bot did, for whom, and how long it took", () => {
    const { log, lines } = collecting();
    const trace = new InteractionLog(command("profile", null), log);
    trace.done({ did: "sent the profile card for zdenek99000", fields: { shifts: 42 } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info", actor: "zdenek99000", msg: "/profile → sent the profile card for zdenek99000", shifts: 42,
    });
    expect(lines[0]).toHaveProperty("durationMs");
  });

  it("logs a refusal as the reason the person was given, not as an error", () => {
    const { log, lines } = collecting();
    new InteractionLog(command("profile", null), log).failed(new UserFacingError("You haven't been tracked on shift yet"));
    expect(lines[0]).toMatchObject({ level: "info", msg: "/profile → refused: You haven't been tracked on shift yet" });
  });

  it("logs anything else as a failure with the error attached", () => {
    const { log, lines } = collecting();
    new InteractionLog(command("profile", null), log).failed(new Error("canvas exploded"));
    expect(lines[0]).toMatchObject({ level: "error", msg: "/profile failed", error: "Error: canvas exploded" });
  });
});
