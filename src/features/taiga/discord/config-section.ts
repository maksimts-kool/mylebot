import { ButtonStyle } from "discord.js";
import type { Config } from "../../../core/config.js";
import { userError } from "../../../core/errors.js";
import {
  actionButton, channelValue, configPage, configRow, countValue, enabledValue, field, forumChannelSelect,
  NOT_CONFIGURED, note, problemsValue, selectedChannel, textChannelSelect, timeValue, toggleButton, toggleChoice,
  type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigComponentInteraction, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import { KNOWN_FORUM_TAGS } from "../domain/mapping.js";
import type { TaigaSettingsService } from "../service/settings.js";
import type { TaigaSyncService } from "../service/taiga-sync.js";

const META: ConfigSectionMeta = {
  id: "taiga",
  label: "Taiga board",
  emoji: "🗂️",
  description: "Forums, notifications channel, and the board sync switch.",
};

const ACTIONS = {
  bugForum: "bug-forum",
  suggestionForum: "suggestion-forum",
  notifications: "notify-channel",
  toggle: "toggle",
  reconcile: "reconcile",
} as const;

/**
 * The Taiga board integration's page in `/config`: the two forums, the
 * notifications channel, the on/off switch, a health check, and a manual
 * reconcile. The feature only builds this when Taiga is configured, so the page
 * never appears on a deployment that cannot use it.
 */
export function taigaConfigSection(
  config: Config,
  settings: TaigaSettingsService,
  sync: TaigaSyncService,
): ConfigSection {
  async function view(): Promise<ConfigView> {
    const current = await settings.get();
    const health = await sync.health();

    const problems: string[] = [...health.problems];
    if (health.missingColumns.length) problems.push(`Taiga board has no column named: ${health.missingColumns.join(", ")}`);
    if (health.missingTags.length) problems.push(`Forum tags missing: ${health.missingTags.join(", ")}`);
    if (!current.notificationChannelId) problems.push("No notifications channel set — card updates will not be announced.");

    return configPage(META, {
      summary: [
        "New forum posts become cards on the Taiga board, and moving a card retags its post.",
        `Forums need these tags: ${KNOWN_FORUM_TAGS.join(", ")}.`,
      ],
      fields: [
        field("Integration", enabledValue(current.enabled)),
        field("Tracked cards", countValue(health.trackedCards)),
        field("Project", config.TAIGA_PROJECT_SLUG || NOT_CONFIGURED),
        field("Bug reports forum", channelValue(current.bugForumChannelId)),
        field("Suggestions forum", channelValue(current.suggestionForumChannelId)),
        field("Notifications", channelValue(current.notificationChannelId)),
        note(
          "Posts tracked from",
          current.activatedAt
            ? `${timeValue(current.activatedAt)} — older posts are never touched`
            : "Not activated yet",
        ),
        note("Health", problemsValue(problems)),
      ],
      rows: [
        forumChannelSelect(META, ACTIONS.bugForum, "Choose the bug reports forum"),
        forumChannelSelect(META, ACTIONS.suggestionForum, "Choose the suggestions forum"),
        textChannelSelect(META, ACTIONS.notifications, "Choose the notifications channel"),
        configRow(
          toggleButton(META, ACTIONS.toggle, current.enabled, "integration"),
          actionButton(META, ACTIONS.reconcile, "Reconcile now", { emoji: "🔄", style: ButtonStyle.Primary }),
        ),
      ],
    });
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (action === ACTIONS.notifications) {
      await settings.setChannel("notificationChannelId", selectedChannel(interaction, "text", "Choose a text channel for notifications").id);
      return null;
    }
    if (action === ACTIONS.bugForum || action === ACTIONS.suggestionForum) {
      const channel = selectedChannel(interaction, "forum", "Choose a forum channel");
      await settings.setChannel(action === ACTIONS.bugForum ? "bugForumChannelId" : "suggestionForumChannelId", channel.id);
      return null;
    }
    const enable = toggleChoice(action, ACTIONS.toggle);
    if (enable !== null) {
      if (enable) {
        const current = await settings.get();
        if (!current.bugForumChannelId || !current.suggestionForumChannelId) userError("Choose both forums before enabling the integration");
        if (!config.TAIGA_USERNAME) userError("Taiga credentials are not configured in the environment");
      }
      await settings.setEnabled(enable);
      return null;
    }
    if (action === ACTIONS.reconcile) {
      await sync.reconcile();
      return null;
    }
    return null;
  }

  return { ...META, view, apply };
}
