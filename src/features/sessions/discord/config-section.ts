import { PermissionFlagsBits, type Client } from "discord.js";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import {
  channelValue, configPage, configRow, countValue, enabledValue, field, note, problemsValue, refreshButton,
  selectedChannel, textChannelSelect, timeValue, toggleButton, toggleChoice, type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigComponentInteraction, ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import type { RuntimeSettingsService } from "../../../shared/runtime-settings.js";

const META: ConfigSectionMeta = {
  id: "tracking",
  label: "Session tracking",
  emoji: "🎮",
};

const ACTIONS = { logs: "logs", staff: "staff", toggle: "toggle" } as const;

/**
 * The sweep runs every 15 seconds. A live session this far past its heartbeat
 * deadline means the sweep is not closing it.
 */
export const SWEEP_GRACE_MS = 60_000;

/** What the publisher needs in a channel to post, edit, and find its messages. */
const CHANNEL_PERMISSIONS = [
  ["View Channel", PermissionFlagsBits.ViewChannel],
  ["Send Messages", PermissionFlagsBits.SendMessages],
  ["Embed Links", PermissionFlagsBits.EmbedLinks],
  ["Read Message History", PermissionFlagsBits.ReadMessageHistory],
] as const;

export type TrackingHealthInput = {
  trackingEnabled: boolean;
  logsChannelId: string;
  /** Live sessions past `lastEventAt + HEARTBEAT_STALE_SECONDS + SWEEP_GRACE_MS`. */
  overdueSessions: number;
  /** One line per channel the bot cannot publish to. */
  channelProblems: string[];
};

/** Everything wrong with session tracking right now, worst first. */
export function trackingProblems(input: TrackingHealthInput): string[] {
  const problems: string[] = [];
  if (!input.logsChannelId) problems.push("No logs channel set — shifts are not published.");
  problems.push(...input.channelProblems);
  // While tracking is off the sweep stands down on purpose.
  if (input.trackingEnabled && input.overdueSessions) {
    problems.push(`${input.overdueSessions} live ${input.overdueSessions === 1 ? "session is" : "sessions are"} past the heartbeat deadline — the sweep is not closing them.`);
  }
  return problems;
}

/**
 * Whether the bot can publish to a configured channel. Reads only the gateway
 * cache; before the client is ready there is nothing to judge, so it says nothing.
 */
export function channelProblem(client: Client, channelId: string, label: string): string | null {
  if (!channelId || !client.isReady()) return null;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return `${label} no longer exists, or the bot cannot see it.`;
  if (channel.isDMBased() || !channel.isTextBased()) return `${label} is not a server text channel.`;
  const granted = channel.permissionsFor(client.user);
  const missing = CHANNEL_PERMISSIONS.filter(([, flag]) => !granted?.has(flag)).map(([name]) => name);
  return missing.length ? `${label} is missing: ${missing.join(", ")}.` : null;
}

/** Session tracking: the on/off switch, where session messages go, and whether it is healthy. */
export function trackingConfigSection(client: Client, db: Db, config: Config, settings: RuntimeSettingsService): ConfigSection {
  async function view(): Promise<ConfigView> {
    const current = await settings.get();
    const live = { state: { not: "ENDED" as const }, deletedAt: null };
    const overdueBefore = new Date(Date.now() - config.HEARTBEAT_STALE_SECONDS * 1000 - SWEEP_GRACE_MS);
    const [liveSessions, overdueSessions, lastEvent] = await Promise.all([
      db.session.count({ where: live }),
      db.session.count({ where: { ...live, lastEventAt: { lt: overdueBefore } } }),
      db.processedEvent.findFirst({ orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    ]);
    const problems = trackingProblems({
      trackingEnabled: current.trackingEnabled,
      logsChannelId: current.logsChannelId,
      overdueSessions,
      channelProblems: [
        channelProblem(client, current.logsChannelId, "Logs channel"),
        channelProblem(client, current.staffChannelId, "Staff chat channel"),
      ].filter((problem): problem is string => problem !== null),
    });

    return configPage(META, {
      fields: [
        field("Tracking", enabledValue(current.trackingEnabled)),
        field("Logs channel", channelValue(current.logsChannelId)),
        field("Staff chat channel", channelValue(current.staffChannelId)),
        field("Live sessions", countValue(liveSessions)),
        field("Last Roblox event", timeValue(lastEvent?.receivedAt, "R", "None on record")),
        note("Health", problemsValue(problems)),
      ],
      rows: [
        textChannelSelect(META, ACTIONS.logs, "Choose the session logs channel"),
        textChannelSelect(META, ACTIONS.staff, "Choose the staff chat channel for shift announcements"),
        configRow(toggleButton(META, ACTIONS.toggle, current.trackingEnabled, "tracking"), refreshButton(META)),
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
