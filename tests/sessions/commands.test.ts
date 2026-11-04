import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { allCommandData } from "../../src/features/command-data.js";
import { parsePermissionAction } from "../../src/features/config/sections/permissions.js";
import {
  requiredPermission,
  sessionCommandData,
} from "../../src/features/sessions/discord/commands/definitions.js";
import { addCustomId, parseAddCustomId } from "../../src/features/sessions/discord/commands/history.js";
import { leaderboardComponents, presetDates } from "../../src/features/sessions/discord/commands/leaderboard.js";
import { friendlyPeriod } from "../../src/features/sessions/discord/commands/format.js";
import { PermissionLevel } from "../../src/shared/permissions.js";

describe("Discord command permissions", () => {
  it("uses the requested access levels", () => {
    expect(requiredPermission("leaderboard")).toBe(PermissionLevel.EVERYONE);
    expect(requiredPermission("session", "view")).toBe(PermissionLevel.STAFF);
    expect(requiredPermission("session", "active")).toBe(PermissionLevel.STAFF);
  });

  it("manages completed sessions from /session view instead of separate subcommands", () => {
    const session = sessionCommandData.find((command) => command.name === "session");
    const subcommands = session?.options?.map((option) => option.name);
    expect(subcommands).toEqual(["active", "view"]);
  });

  it("round-trips the history's add control for tracked and never-tracked members", () => {
    expect(addCustomId({ identityId: "clx123" })).toBe("session:add:i:clx123");
    expect(parseAddCustomId("session:add:i:clx123")).toEqual({ identityId: "clx123" });
    expect(addCustomId({ discordUserId: "1485701483038118059" })).toBe("session:add:u:1485701483038118059");
    expect(parseAddCustomId("session:add:u:1485701483038118059")).toEqual({ discordUserId: "1485701483038118059" });
    expect(parseAddCustomId("session:add:x:1")).toBeNull();
    expect(parseAddCustomId("session:add:i:")).toBeNull();
    expect(parseAddCustomId("session:manage")).toBeNull();
  });

  it("deploys /session active with an optional user option", () => {
    const session = sessionCommandData.find((command) => command.name === "session");
    const active = session?.options?.find((option) => option.name === "active") as
      | { options?: Array<{ name: string; required?: boolean }> }
      | undefined;
    expect(active).toBeDefined();
    const user = active?.options?.find((option) => option.name === "user");
    expect(user).toBeDefined();
    expect(user?.required ?? false).toBe(false);
  });

  it("parses role permission button choices", () => {
    expect(parsePermissionAction("level:123456789012345678:4")).toEqual({
      roleId: "123456789012345678",
      choice: "4",
    });
    expect(parsePermissionAction("level:123456789012345678:remove")).toEqual({
      roleId: "123456789012345678",
      choice: "remove",
    });
    expect(parsePermissionAction("role")).toBeNull();
  });
});

describe("deployed command set", () => {
  const baseEnv = {
    DATABASE_URL: "postgresql://example.invalid/db",
    ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
    ROBLOX_UNIVERSE_ID: "100",
    ROBLOX_GROUP_ID: "200",
    ROBLOX_ALLOWED_PLACE_IDS: "300",
  };

  it("includes every session command and no duplicate names", () => {
    const names = allCommandData(loadConfig(baseEnv)).map((command) => command.name);
    for (const command of sessionCommandData) expect(names).toContain(command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("always deploys the shared /config and /help commands", () => {
    const names = allCommandData(loadConfig(baseEnv)).map((command) => command.name);
    expect(names).toContain("config");
    expect(names).toContain("help");
  });

  it("no longer deploys a separate /taiga command now that its settings live in /config", () => {
    const withTaiga = allCommandData(loadConfig({
      ...baseEnv,
      TAIGA_USERNAME: "bot",
      TAIGA_PASSWORD: "secret",
      TAIGA_PROJECT_SLUG: "my-project",
    })).map((command) => command.name);
    expect(withTaiga).not.toContain("taiga");
  });

  it("only deploys /verification when verification is configured", () => {
    const withoutVerification = allCommandData(loadConfig(baseEnv)).map((command) => command.name);
    expect(withoutVerification).not.toContain("verification");

    const withVerification = allCommandData(loadConfig({
      ...baseEnv,
      DISCORD_GUILD_ID: "1068891577054933083",
      VERIFICATION_CHANNEL_ID: "1087381025291780147",
      VERIFICATION_UNVERIFIED_ROLE_ID: "1087383526078423070",
    })).map((command) => command.name);
    expect(withVerification).toContain("verification");
  });
});

describe("leaderboard period labels", () => {
  it("shows a month as a day range, the same way as a week or a year", () => {
    expect(friendlyPeriod("2026-11-01", "2026-11-30", "Europe/Tallinn")).toBe("Nov 1 – Nov 30, 2026");
    expect(friendlyPeriod("2026-09-14", "2026-12-31", "Europe/Tallinn")).toBe("Sep 14 – Dec 31, 2026");
  });

  it("shows a day range for a week that sits inside one month", () => {
    expect(friendlyPeriod("2026-07-13", "2026-07-19", "Europe/Tallinn")).toBe("Jul 13 – Jul 19, 2026");
  });

  it("shows a day range for a week that straddles two months", () => {
    expect(friendlyPeriod("2026-06-29", "2026-07-05", "Europe/Tallinn")).toBe("Jun 29 – Jul 5, 2026");
  });

  it("shows full dates for a span that crosses years", () => {
    expect(friendlyPeriod("2006-01-01", "2026-07-13", "Europe/Tallinn")).toBe("Jan 1, 2006 – Jul 13, 2026");
  });
});

describe("leaderboard periods", () => {
  const config = { REPORT_TIMEZONE: "Europe/Tallinn" } as never;
  const now = new Date("2026-11-04T12:00:00Z");

  it("offers no all-time period, because sessions are only kept for a year", () => {
    const leaderboard = sessionCommandData.find((command) => command.name === "leaderboard");
    const choices = (leaderboard?.options?.[0] as { choices?: Array<{ value: string }> }).choices?.map((choice) => choice.value);
    expect(choices).toEqual(["week", "month", "year"]);
  });

  it("starts this year at the first recorded session, not Jan 1", () => {
    expect(presetDates(config, "year", new Date("2026-09-14T08:00:00Z"), now)).toEqual({ startDate: "2026-09-14", endDate: "2026-12-31" });
  });

  it("starts at the first recorded session in the reporting time zone", () => {
    // 22:30 UTC on Sep 13 is already Sep 14 in Tallinn.
    expect(presetDates(config, "year", new Date("2026-09-13T22:30:00Z"), now).startDate).toBe("2026-09-14");
  });

  it("keeps the calendar start once tracking predates the period, or before anything is recorded", () => {
    expect(presetDates(config, "month", new Date("2026-09-14T08:00:00Z"), now)).toEqual({ startDate: "2026-11-01", endDate: "2026-11-30" });
    expect(presetDates(config, "week", null, now)).toEqual({ startDate: "2026-11-02", endDate: "2026-11-08" });
    expect(presetDates(config, "year", null, now)).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" });
  });
});

describe("leaderboard controls", () => {
  const labels = (rowCount: number, page = 0) => {
    const rows = Array.from({ length: Math.min(rowCount, 10) }, (_, i) => ({ identityId: `${i}`, username: `user${i}` }));
    const buttonRow = leaderboardComponents(rows, rowCount, "2026-11-01", "2026-11-30", 0, page).at(-1)!.toJSON();
    return buttonRow.components.map((button) => (button as { label?: string }).label);
  };

  it("shows only Refresh when everyone fits on one page", () => {
    expect(labels(3)).toEqual(["Refresh"]);
    expect(labels(10)).toEqual(["Refresh"]);
  });

  it("adds paging once there is a second page", () => {
    expect(labels(11)).toEqual(["Previous", "Refresh", "Next"]);
  });
});
