import { describe, expect, it, vi } from "vitest";
import { RuntimeSettingsService } from "../../src/shared/runtime-settings.js";

describe("runtime settings", () => {
  it("has no channels until a manager configures them in Discord", async () => {
    const db = {
      runtimeSettings: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ logsChannelId: "configured-channel", staffChannelId: null, trackingEnabled: true }),
      },
    };
    const settings = new RuntimeSettingsService(db as never);

    await expect(settings.get()).resolves.toEqual({ logsChannelId: "", staffChannelId: "", trackingEnabled: true });
    await expect(settings.setLogsChannel("configured-channel")).resolves.toEqual({
      logsChannelId: "configured-channel",
      staffChannelId: "",
      trackingEnabled: true,
    });
    expect(db.runtimeSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { id: "global", logsChannelId: "configured-channel" },
    }));
  });

  it("stores the staff announcement channel separately from the logs channel", async () => {
    const db = {
      runtimeSettings: {
        findUnique: vi.fn(),
        upsert: vi.fn().mockResolvedValue({ logsChannelId: "logs", staffChannelId: "staff-chat", trackingEnabled: true }),
      },
    };
    const settings = new RuntimeSettingsService(db as never);

    await expect(settings.setStaffChannel("staff-chat")).resolves.toEqual({
      logsChannelId: "logs",
      staffChannelId: "staff-chat",
      trackingEnabled: true,
    });
    expect(db.runtimeSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { id: "global", staffChannelId: "staff-chat" },
      update: { staffChannelId: "staff-chat" },
    }));
  });
});
