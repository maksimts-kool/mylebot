import type { Db } from "../core/db.js";

const SETTINGS_ID = "global";

export type RuntimeSettings = {
  logsChannelId: string;
  /** Staff chat channel shift announcements go to. Empty disables them. */
  staffChannelId: string;
  trackingEnabled: boolean;
};

type SavedSettings = { logsChannelId: string | null; staffChannelId: string | null; trackingEnabled: boolean };

function toSettings(saved: SavedSettings | null): RuntimeSettings {
  return {
    logsChannelId: saved?.logsChannelId ?? "",
    staffChannelId: saved?.staffChannelId ?? "",
    trackingEnabled: saved?.trackingEnabled ?? true,
  };
}

export class RuntimeSettingsService {
  constructor(private readonly db: Db) { }

  async get(): Promise<RuntimeSettings> {
    return toSettings(await this.db.runtimeSettings.findUnique({ where: { id: SETTINGS_ID } }));
  }

  async setLogsChannel(logsChannelId: string): Promise<RuntimeSettings> {
    return toSettings(await this.db.runtimeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, logsChannelId },
      update: { logsChannelId },
    }));
  }

  async setStaffChannel(staffChannelId: string): Promise<RuntimeSettings> {
    return toSettings(await this.db.runtimeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, staffChannelId },
      update: { staffChannelId },
    }));
  }

  async setTrackingEnabled(trackingEnabled: boolean): Promise<RuntimeSettings> {
    return toSettings(await this.db.runtimeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, trackingEnabled },
      update: { trackingEnabled },
    }));
  }
}
