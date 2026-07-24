import type { Db } from "../core/db.js";

const SETTINGS_ID = "global";

export type RuntimeSettings = {
  logsChannelId: string;
  trackingEnabled: boolean;
};

export class RuntimeSettingsService {
  constructor(private readonly db: Db) { }

  async get(): Promise<RuntimeSettings> {
    const saved = await this.db.runtimeSettings.findUnique({ where: { id: SETTINGS_ID } });
    return {
      logsChannelId: saved?.logsChannelId ?? "",
      trackingEnabled: saved?.trackingEnabled ?? true,
    };
  }

  async setLogsChannel(logsChannelId: string): Promise<RuntimeSettings> {
    const saved = await this.db.runtimeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, logsChannelId },
      update: { logsChannelId },
    });
    return { logsChannelId: saved.logsChannelId ?? "", trackingEnabled: saved.trackingEnabled };
  }

  async setTrackingEnabled(trackingEnabled: boolean): Promise<RuntimeSettings> {
    const saved = await this.db.runtimeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, trackingEnabled },
      update: { trackingEnabled },
    });
    return { logsChannelId: saved.logsChannelId ?? "", trackingEnabled: saved.trackingEnabled };
  }
}
