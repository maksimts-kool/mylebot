import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RuntimeSettingsService } from "../src/services/runtime-settings.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://example.invalid/db",
  DISCORD_SESSION_CHANNEL_ID: "default-channel",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
});

describe("runtime settings", () => {
  it("uses the environment channel until a manager saves an override", async () => {
    const db = {
      runtimeSettings: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ logsChannelId: "configured-channel", trackingEnabled: true }),
      },
    };
    const settings = new RuntimeSettingsService(db as never, config);

    await expect(settings.get()).resolves.toEqual({ logsChannelId: "default-channel", trackingEnabled: true });
    await expect(settings.setLogsChannel("configured-channel")).resolves.toEqual({ logsChannelId: "configured-channel", trackingEnabled: true });
    expect(db.runtimeSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { id: "global", logsChannelId: "configured-channel" },
    }));
  });
});
