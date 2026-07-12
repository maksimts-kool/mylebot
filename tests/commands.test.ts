import { describe, expect, it } from "vitest";
import {
  PermissionLevel,
  commandData,
  formatSessionDateTime,
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
