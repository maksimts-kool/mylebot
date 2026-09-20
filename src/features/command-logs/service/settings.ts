import type { Db } from "../../../core/db.js";

const SETTINGS_ID = "global";

export type CommandLogSettings = {
  enabled: boolean;
  /** Channel the per-server threads are created in. Empty disables posting. */
  channelId: string;
  includeStudio: boolean;
};

const EMPTY: CommandLogSettings = { enabled: false, channelId: "", includeStudio: true };

export class CommandLogSettingsService {
  constructor(private readonly db: Db) {}

  async get(): Promise<CommandLogSettings> {
    const saved = await this.db.commandLogSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!saved) return EMPTY;
    return { enabled: saved.enabled, channelId: saved.channelId ?? "", includeStudio: saved.includeStudio };
  }

  async setChannel(channelId: string): Promise<CommandLogSettings> {
    await this.db.commandLogSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, channelId },
      update: { channelId },
    });
    return this.get();
  }

  async setEnabled(enabled: boolean): Promise<CommandLogSettings> {
    await this.db.commandLogSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, enabled },
      update: { enabled },
    });
    return this.get();
  }

  async setIncludeStudio(includeStudio: boolean): Promise<CommandLogSettings> {
    await this.db.commandLogSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, includeStudio },
      update: { includeStudio },
    });
    return this.get();
  }
}
