import {
  channelValue, configPage, configRow, countValue, enabledValue, field, note, problemsValue,
  refreshButton, selectedChannel, textChannelSelect, toggleButton, toggleChoice,
  type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigComponentInteraction, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import type { CommandLogsServerPort } from "../link.js";

const META: ConfigSectionMeta = {
  id: "commandlogs",
  label: "Command logs",
  emoji: "🧾",
};

const ACTIONS = { channel: "channel", toggle: "toggle", studio: "studio" } as const;

/**
 * The Adonis command log's page in `/config`: the channel the per-server
 * threads are created in, the on/off switch, and whether Studio playtests are
 * logged alongside live servers.
 */
export function commandLogsConfigSection(
  logs: Pick<CommandLogsServerPort, "overview" | "setChannel" | "setEnabled" | "setIncludeStudio">,
): ConfigSection {
  async function view(): Promise<ConfigView> {
    const { settings: current, stats } = await logs.overview();

    const problems: string[] = [];
    if (!current.channelId) problems.push("No channel set — command runs cannot be posted anywhere.");
    if (current.enabled && !current.channelId) problems.push("Logging is on but has nowhere to post.");

    return configPage(META, {
      fields: [
        field("Logging", enabledValue(current.enabled)),
        field("Channel", channelValue(current.channelId)),
        field("Studio playtests", enabledValue(current.includeStudio)),
        field("Live servers", countValue(stats.servers)),
        field("Runs in 24h", countValue(stats.runsToday)),
        field("Access blocks", countValue(stats.blocks)),
        note("Health", problemsValue(problems)),
      ],
      rows: [
        textChannelSelect(META, ACTIONS.channel, "Choose the command log channel"),
        configRow(
          toggleButton(META, ACTIONS.toggle, current.enabled, "logging"),
          toggleButton(META, ACTIONS.studio, current.includeStudio, "Studio logs"),
          refreshButton(META),
        ),
      ],
    });
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (action === ACTIONS.channel) {
      await logs.setChannel(selectedChannel(interaction, "text", "Choose a text channel for command logs").id);
      return null;
    }
    const enable = toggleChoice(action, ACTIONS.toggle);
    if (enable !== null) {
      // Turning it on with nowhere to post is refused by the server half.
      await logs.setEnabled(enable);
      return null;
    }
    const studio = toggleChoice(action, ACTIONS.studio);
    if (studio !== null) {
      await logs.setIncludeStudio(studio);
      return null;
    }
    return null;
  }

  return { ...META, view, apply };
}
