import { describe, expect, it } from "vitest";
import {
  PermissionLevel,
  commandData,
  formatSessionDateTime,
  friendlyPeriod,
  parsePermissionRoleChoice,
  parseSessionDateTime,
  requiredPermission,
} from "../src/discord/commands.js";

describe("Discord command permissions", () => {
  it("uses the requested access levels", () => {
    expect(requiredPermission("leaderboard")).toBe(PermissionLevel.EVERYONE);
    expect(requiredPermission("session", "view")).toBe(PermissionLevel.STAFF);
    expect(requiredPermission("session", "add")).toBe(PermissionLevel.ADMIN);
    expect(requiredPermission("session", "manage")).toBe(PermissionLevel.ADMIN);
    expect(requiredPermission("config", "tracking")).toBe(PermissionLevel.MANAGER);
  });

  it("deploys the manager configuration command", () => {
    const config = commandData.find((command) => command.name === "config");
    expect(config?.options).toEqual([]);
  });

  it("parses role permission button choices", () => {
    expect(parsePermissionRoleChoice("config-role-level:123456789012345678:4")).toEqual({
      roleId: "123456789012345678",
      choice: "4",
    });
    expect(parsePermissionRoleChoice("config-role-level:123456789012345678:remove")).toEqual({
      roleId: "123456789012345678",
      choice: "remove",
    });
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
