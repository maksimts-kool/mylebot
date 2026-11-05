import type { CommandLogEntry, CommandLogThread } from "@prisma/client";
import type { ShiftStatus } from "../../shared/staff-activity.js";
import type { StoredStaff } from "./domain/roster.js";
import type { CommandLogSettings } from "./service/settings.js";

/**
 * The contract between the two halves of the Adonis command log. The server
 * half takes in what the game reports, keeps the rows and the blocks, and
 * decides what each server's panel and thread should show; the bot half draws
 * them in Discord and answers presses on the panels.
 */

export const COMMAND_LOGS_PORT = "commandLogs";

/** The part of a server's row its panel is drawn from. */
export type PanelServer = Pick<CommandLogThread, "jobId" | "placeId" | "serverType" | "playerCount" | "maxPlayers" | "lastSeenAt" | "closedAt">;

/** Everything one server's panel shows. */
export type PanelView = {
  server: PanelServer;
  staff: StoredStaff[];
  /** When each blocked person gets their commands back, by Roblox user ID. */
  blockedUntil: Map<string, Date>;
  /** Whether each of them is on a tracked shift, by Roblox user ID. */
  shifts: Map<string, ShiftStatus>;
};

/** What a posted command run says besides the run itself. */
export type CommandRunView = {
  /** The Discord account the runner is linked to, when Bloxlink knows one. */
  discordUserId: string | null;
  /** Whether they were on a tracked shift when they ran it. */
  shift: ShiftStatus;
};

/** Where a server's panel and thread are, as the server half records them. */
export type PanelLocation = { jobId: string; channelId: string; threadId: string; panelMessageId: string | null };

/** What the server half asks of Discord for this feature. */
export interface CommandLogsBotPort {
  /**
   * Posts a server's panel in `channelId` and starts its log thread from it.
   * Null when the channel cannot hold one.
   */
  openPanel(channelId: string, panel: PanelView): Promise<{ channelId: string; threadId: string; messageId: string } | null>;
  /** Redraws a panel. `gone` means the message, and with it the thread, no longer exists. */
  editPanel(channelId: string, messageId: string, panel: PanelView): Promise<"edited" | "gone">;
  /** Takes a panel and its thread out of the channel. Anything already gone counts as removed. */
  removePanel(location: PanelLocation): Promise<void>;
  /** Posts one run in its server's thread. Null when the thread is gone. */
  postRun(threadId: string, entry: CommandLogEntry, view: CommandRunView): Promise<{ messageId: string } | null>;
  /** Leaves a line in a server's thread. Does nothing when the thread is gone. */
  notice(threadId: string, content: string): Promise<void>;
}

/** A press on a panel's menu, as Discord delivered it. */
export type PanelPress = {
  panelMessageId: string;
  /** The Roblox user ID picked from the menu. */
  robloxUserId: string;
  presser: { discordUserId: string; username: string };
};

export type AccessOutcome =
  | { status: "already_blocked"; username: string; jobId: string; expiresAt: Date }
  | { status: "blocked"; username: string; jobId: string; expiresAt: Date }
  | { status: "restored"; username: string; jobId: string }
  | { status: "not_blocked"; username: string; jobId: string };

export type CommandLogOverview = {
  settings: CommandLogSettings;
  stats: { servers: number; blocks: number; runsToday: number };
};

/** What the panels and the `/config` page ask of the server half. */
export interface CommandLogsServerPort {
  /** Takes command access away from the picked member. Throws a user-facing reason when the presser may not. */
  disableAccess(press: PanelPress): Promise<AccessOutcome>;
  /** Gives it back early. Throws a user-facing reason when the presser may not. */
  restoreAccess(press: PanelPress): Promise<AccessOutcome>;
  overview(): Promise<CommandLogOverview>;
  setChannel(channelId: string): Promise<void>;
  /** Throws a user-facing reason when logging is switched on with nowhere to post. */
  setEnabled(enabled: boolean): Promise<void>;
  setIncludeStudio(includeStudio: boolean): Promise<void>;
}
