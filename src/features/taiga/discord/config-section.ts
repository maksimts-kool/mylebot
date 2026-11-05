import { ButtonStyle, type Client } from "discord.js";
import {
  actionButton, channelValue, configPage, configRow, countValue, enabledValue, field, forumChannelSelect,
  NOT_CONFIGURED, note, problemsValue, selectedChannel, textChannelSelect, timeValue, toggleButton, toggleChoice,
  type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigComponentInteraction, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import { KNOWN_FORUM_TAGS } from "../domain/mapping.js";
import type { TaigaServerPort } from "../link.js";
import { fetchForumChannel, resolveTagIds } from "./tags.js";

const META: ConfigSectionMeta = {
  id: "taiga",
  label: "Taiga board",
  emoji: "🗂️",
};

const ACTIONS = {
  bugForum: "bug-forum",
  suggestionForum: "suggestion-forum",
  notifications: "notify-channel",
  toggle: "toggle",
  reconcile: "reconcile",
} as const;

/** What is wrong with the two forums, read off the gateway: unreachable forums and missing tags. */
export async function forumProblems(client: Client, forumIds: string[]): Promise<{ problems: string[]; missingTags: string[] }> {
  const problems: string[] = [];
  const missingTags = new Set<string>();
  for (const channelId of forumIds) {
    if (!channelId) continue;
    const forum = await fetchForumChannel(client, channelId).catch(() => null);
    if (!forum) {
      problems.push(`<#${channelId}> is not a reachable forum channel`);
      continue;
    }
    for (const name of resolveTagIds(forum, KNOWN_FORUM_TAGS).missing) missingTags.add(name);
  }
  return { problems, missingTags: [...missingTags] };
}

/**
 * The Taiga board integration's page in `/config`: the two forums, the
 * notifications channel, the on/off switch, a health check, and a manual
 * reconcile. The page only exists when the server half runs the integration.
 * The board's health comes from the server half; the forums' is read here.
 */
export function taigaConfigSection(
  client: Client,
  taiga: Pick<TaigaServerPort, "overview" | "setChannel" | "setEnabled" | "reconcile">,
): ConfigSection {
  async function view(): Promise<ConfigView> {
    const overview = await taiga.overview();
    const current = overview.settings;
    const forums = await forumProblems(client, [current.bugForumChannelId, current.suggestionForumChannelId]);

    const problems: string[] = [...overview.problems, ...forums.problems];
    if (overview.missingColumns.length) problems.push(`Taiga board has no column named: ${overview.missingColumns.join(", ")}`);
    if (forums.missingTags.length) problems.push(`Forum tags missing: ${forums.missingTags.join(", ")}`);
    if (!current.notificationChannelId) problems.push("No notifications channel set — card updates will not be announced.");

    return configPage(META, {
      fields: [
        field("Integration", enabledValue(current.enabled)),
        field("Tracked cards", countValue(overview.trackedCards)),
        field("Project", overview.projectSlug || NOT_CONFIGURED),
        field("Bug reports forum", channelValue(current.bugForumChannelId)),
        field("Suggestions forum", channelValue(current.suggestionForumChannelId)),
        field("Notifications", channelValue(current.notificationChannelId)),
        note(
          "Posts tracked from",
          current.activatedAt ? timeValue(current.activatedAt) : "Not activated yet",
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
      await taiga.setChannel("notificationChannelId", selectedChannel(interaction, "text", "Choose a text channel for notifications").id);
      return null;
    }
    if (action === ACTIONS.bugForum || action === ACTIONS.suggestionForum) {
      const channel = selectedChannel(interaction, "forum", "Choose a forum channel");
      await taiga.setChannel(action === ACTIONS.bugForum ? "bugForumChannelId" : "suggestionForumChannelId", channel.id);
      return null;
    }
    const enable = toggleChoice(action, ACTIONS.toggle);
    if (enable !== null) {
      // Switching on before both forums are chosen is refused by the server half.
      await taiga.setEnabled(enable);
      return null;
    }
    if (action === ACTIONS.reconcile) {
      await taiga.reconcile();
      return null;
    }
    return null;
  }

  return { ...META, view, apply };
}
