import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { allCommandData } from "../../src/features/command-data.js";
import { parsePermissionAction } from "../../src/features/config/sections/permissions.js";
import {
  requiredPermission,
  sessionCommandData,
} from "../../src/features/sessions/discord/commands/definitions.js";
import {
  formatSessionDateTime,
  friendlyPeriod,
  parseSessionDateTime,
} from "../../src/features/sessions/discord/commands/format.js";
import { PermissionLevel } from "../../src/shared/permissions.js";

describe("Discord command permissions", () => {
  it("uses the requested access levels", () => {
    expect(requiredPermission("leaderboard")).toBe(PermissionLevel.EVERYONE);
    expect(requiredPermission("session", "view")).toBe(PermissionLevel.STAFF);
    expect(requiredPermission("session", "active")).toBe(PermissionLevel.STAFF);
    expect(requiredPermission("session", "add")).toBe(PermissionLevel.ADMIN);
    expect(requiredPermission("session", "manage")).toBe(PermissionLevel.ADMIN);
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

describe("manual session date input", () => {
  it("accepts a simple local date and time in the reporting timezone", () => {
    const parsed = parseSessionDateTime("11/07/2026 14:30", "Europe/Tallinn");
    expect(parsed.toISOString()).toBe("2026-07-11T11:30:00.000Z");
    expect(formatSessionDateTime(parsed, "Europe/Tallinn")).toBe("11/07/2026 14:30");
  });

  it("keeps accepting ISO timestamps and gives a useful error for invalid input", () => {
    expect(parseSessionDateTime("2026-07-11T14:30:00Z", "Europe/Tallinn").toISOString()).toBe("2026-07-11T14:30:00.000Z");
    expect(() => parseSessionDateTime("tomorrow afternoon", "Europe/Tallinn")).toThrow(/11\/07\/2026 14:30/);
  });
});

describe("leaderboard period labels", () => {
  it("names a full calendar month", () => {
    expect(friendlyPeriod("2026-07-01", "2026-07-31", "Europe/Tallinn")).toBe("July 2026");
    expect(friendlyPeriod("2026-02-01", "2026-02-28", "Europe/Tallinn")).toBe("February 2026");
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
