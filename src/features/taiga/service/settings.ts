import type { Db } from "../../../core/db.js";

const SETTINGS_ID = "global";

export type TaigaSettings = {
  enabled: boolean;
  bugForumChannelId: string;
  suggestionForumChannelId: string;
  notificationChannelId: string;
  activatedAt: Date | null;
  epicsSeededAt: Date | null;
};

const EMPTY: TaigaSettings = {
  enabled: false,
  bugForumChannelId: "",
  suggestionForumChannelId: "",
  notificationChannelId: "",
  activatedAt: null,
  epicsSeededAt: null,
};

export class TaigaSettingsService {
  constructor(private readonly db: Db) {}

  async get(): Promise<TaigaSettings> {
    const saved = await this.db.taigaSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!saved) return EMPTY;
    return {
      enabled: saved.enabled,
      bugForumChannelId: saved.bugForumChannelId ?? "",
      suggestionForumChannelId: saved.suggestionForumChannelId ?? "",
      notificationChannelId: saved.notificationChannelId ?? "",
      activatedAt: saved.activatedAt,
      epicsSeededAt: saved.epicsSeededAt,
    };
  }

  async setChannel(field: "bugForumChannelId" | "suggestionForumChannelId" | "notificationChannelId", channelId: string): Promise<TaigaSettings> {
    await this.db.taigaSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, [field]: channelId },
      update: { [field]: channelId },
    });
    return this.get();
  }

  /**
   * Switching the integration on stamps `activatedAt` the first time. Every
   * forum post older than that stamp is ignored forever, so enabling the
   * feature never back-fills the existing forums.
   */
  async setEnabled(enabled: boolean): Promise<TaigaSettings> {
    const current = await this.db.taigaSettings.findUnique({ where: { id: SETTINGS_ID } });
    const activatedAt = enabled ? current?.activatedAt ?? new Date() : current?.activatedAt ?? null;
    await this.db.taigaSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, enabled, activatedAt },
      update: { enabled, activatedAt },
    });
    return this.get();
  }

  /** Marks the existing epics as recorded, so later ones count as new. */
  async markEpicsSeeded(now = new Date()): Promise<void> {
    await this.db.taigaSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, epicsSeededAt: now },
      update: { epicsSeededAt: now },
    });
  }
}
