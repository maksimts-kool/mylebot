import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PermissionLevel,
  PublicComponentTracker,
  commandData,
  formatSessionDateTime,
  friendlyPeriod,
  parsePermissionRoleChoice,
  parseSessionDateTime,
  requiredPermission,
} from "../src/discord/commands.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord command permissions", () => {
  it("uses the requested access levels", () => {
    expect(requiredPermission("leaderboard")).toBe(PermissionLevel.EVERYONE);
    expect(requiredPermission("session", "view")).toBe(PermissionLevel.STAFF);
    expect(requiredPermission("session", "active")).toBe(PermissionLevel.STAFF);
    expect(requiredPermission("session", "add")).toBe(PermissionLevel.ADMIN);
    expect(requiredPermission("session", "manage")).toBe(PermissionLevel.ADMIN);
    expect(requiredPermission("config", "tracking")).toBe(PermissionLevel.MANAGER);
  });

  it("deploys /session active with an optional user option", () => {
    const session = commandData.find((command) => command.name === "session");
    const active = session?.options?.find((option) => option.name === "active") as
      | { options?: Array<{ name: string; required?: boolean }> }
      | undefined;
    expect(active).toBeDefined();
    const user = active?.options?.find((option) => option.name === "user");
    expect(user).toBeDefined();
    expect(user?.required ?? false).toBe(false);
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

describe("public command controls", () => {
  it("allows only the caller while the message is tracked", () => {
    const tracker = new PublicComponentTracker();
    tracker.track("message-1", "caller-1", async () => {});

    expect(tracker.access("message-1", "caller-1")).toBe("allowed");
    expect(tracker.access("message-1", "someone-else")).toBe("not-owner");
    expect(tracker.access("unknown-message", "caller-1")).toBe("expired");
  });

  it("expires and disables tracked controls after the lifetime", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn(async () => {});
    const tracker = new PublicComponentTracker(1_000);
    tracker.track("message-1", "caller-1", onExpire);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(tracker.access("message-1", "caller-1")).toBe("expired");
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("keeps controls alive while the caller is using them", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn(async () => {});
    const tracker = new PublicComponentTracker(1_000);
    tracker.track("message-1", "caller-1", onExpire);

    await vi.advanceTimersByTimeAsync(750);
    expect(tracker.access("message-1", "caller-1")).toBe("allowed");
    await vi.advanceTimersByTimeAsync(750);

    expect(tracker.access("message-1", "caller-1")).toBe("allowed");
    expect(onExpire).not.toHaveBeenCalled();
  });
});
