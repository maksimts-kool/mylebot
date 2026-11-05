import type { Config } from "../../../core/config.js";
import { userError } from "../../../core/errors.js";
import type { TaigaServerPort } from "../link.js";
import type { TaigaSettingsService } from "./settings.js";
import type { TaigaSyncService } from "./taiga-sync.js";

/** What the forum listener and the `/config` page ask of the server half. */
export function taigaServerPort(config: Config, settings: TaigaSettingsService, sync: TaigaSyncService): TaigaServerPort {
  return {
    threadCreated: (post) => sync.handleThreadCreated(post),
    threadDeleted: (threadId) => sync.handleThreadDeleted(threadId),

    async overview() {
      const [current, health] = await Promise.all([settings.get(), sync.health()]);
      return {
        settings: current,
        projectSlug: config.TAIGA_PROJECT_SLUG,
        trackedCards: health.trackedCards,
        missingColumns: health.missingColumns,
        problems: health.problems,
      };
    },

    setChannel: async (field, channelId) => { await settings.setChannel(field, channelId); },

    async setEnabled(enabled) {
      if (enabled) {
        const current = await settings.get();
        if (!current.bugForumChannelId || !current.suggestionForumChannelId) userError("Choose both forums before enabling the integration");
        if (!config.TAIGA_USERNAME) userError("Taiga credentials are not configured in the environment");
      }
      await settings.setEnabled(enabled);
    },

    reconcile: () => sync.reconcile(),
  };
}
