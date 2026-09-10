import {
  channelValue, configPage, configRow, enabledValue, field, note, selectedChannel, textChannelSelect,
  toggleButton, toggleChoice, type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigComponentInteraction, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";

const META: ConfigSectionMeta = {
  id: "tracking",
  label: "Session tracking",
  emoji: "🎮",
  description: "Tracking on/off, the session logs channel, and the staff announcement channel.",
};

const ACTIONS = { logs: "logs", staff: "staff", toggle: "toggle" } as const;

/** Session tracking: the on/off switch and where session messages are posted. */
export function trackingSection(settings: RuntimeSettingsService): ConfigSection {
  async function view(): Promise<ConfigView> {
    const current = await settings.get();
    return configPage(META, {
      summary: "Roblox session tracking and the channels the bot publishes session messages to.",
      fields: [
        field("Tracking", enabledValue(current.trackingEnabled)),
        field("Logs channel", channelValue(current.logsChannelId)),
        field("Staff chat channel", channelValue(current.staffChannelId)),
        note(
          "Where each message goes",
          [
            "The logs channel keeps the full record of every shift.",
            "The staff chat channel gets a short announcement per shift that mentions the member, is edited when they finish, and is taken down five minutes after that so the channel stays clear.",
            "Leave the staff channel unset to switch announcements off.",
          ].join(" "),
        ),
        note(
          "What the switch does",
          "While tracking is disabled the bot ignores incoming Roblox events and stops sweeping live sessions. Nothing already recorded is deleted.",
        ),
      ],
      rows: [
        textChannelSelect(META, ACTIONS.logs, "Choose the session logs channel"),
        textChannelSelect(META, ACTIONS.staff, "Choose the staff chat channel for shift announcements"),
        configRow(toggleButton(META, ACTIONS.toggle, current.trackingEnabled, "tracking")),
      ],
    });
  }

  async function apply(interaction: ConfigComponentInteraction, action: string): Promise<ConfigView | null> {
    if (action === ACTIONS.logs) {
      await settings.setLogsChannel(selectedChannel(interaction, "text", "Choose a text channel for session logs").id);
      return null;
    }
    if (action === ACTIONS.staff) {
      await settings.setStaffChannel(selectedChannel(interaction, "text", "Choose a text channel for staff announcements").id);
      return null;
    }
    const enable = toggleChoice(action, ACTIONS.toggle);
    if (enable !== null) await settings.setTrackingEnabled(enable);
    return null;
  }

  return { ...META, view, apply };
}
