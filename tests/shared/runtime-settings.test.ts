import { describe, expect, it, vi } from "vitest";
import { RuntimeSettingsService } from "../../src/shared/runtime-settings.js";

describe("runtime settings", () => {
  it("has no logs channel until a manager configures one in Discord", async () => {
    const db = {
      runtimeSettings: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ logsChannelId: "configured-channel", trackingEnabled: true }),
      },
    };
    const settings = new RuntimeSettingsService(db as never);

    await expect(settings.get()).resolves.toEqual({ logsChannelId: "", trackingEnabled: true });
    await expect(settings.setLogsChannel("configured-channel")).resolves.toEqual({ logsChannelId: "configured-channel", trackingEnabled: true });
    expect(db.runtimeSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { id: "global", logsChannelId: "configured-channel" },
    }));
  });
});
