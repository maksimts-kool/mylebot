import type { BadgeAward, Identity, Session, SessionState, TimeSegment } from "@prisma/client";
import type { RuntimeSettings } from "../../shared/runtime-settings.js";
import type { CommandActivity } from "../../shared/staff-activity.js";
import type { Totals } from "./domain/accounting.js";
import type { ProfileStats } from "./domain/profile.js";
import type { LeaderboardRow } from "./domain/reporting.js";

/**
 * The contract between the two halves of session tracking. The server half
 * owns the lifecycle, the accounting and every row; the bot half renders what
 * the server hands it and answers the slash commands. Nothing here is code
 * either half runs — only the names of the ports and the shapes they carry.
 */

/** The port name both halves use for this feature. */
export const SESSIONS_PORT = "sessions";

export type DiscordMessageReference = { channelId: string; messageId: string };

// ---------------------------------------------------------------- Bot → server

/** Whose history to show: a tracked identity, or a Bloxlink-mapped member it has never seen. */
export type HistorySubject = { identityId: string } | { discordUserId: string };

/** One session as `/session active` and the "More info" button show it. */
export type SessionDetail = Session & {
  identity: Identity;
  segments: TimeSegment[];
  /** The Adonis commands run during the shift; empty when none are on record. */
  commands: CommandActivity;
};

export type LiveSession = Session & { identity: Identity; segments: TimeSegment[] };

export type SessionHistory = { identity: Identity; sessions: Array<Session & { segments: TimeSegment[] }> };

/** A completed session an Admin may edit or remove. */
export type ManagedSession = Session & { identity: Identity };

export type ManualSessionInput = {
  subject: HistorySubject;
  start: Date;
  end: Date;
  activeMs: number;
  inactiveMs: number;
  note: string;
  actorDiscordId: string;
};

export type EditSessionInput = {
  sessionId: string;
  start: Date;
  end: Date;
  activeMs: number;
  inactiveMs: number;
  note: string;
  actorDiscordId: string;
};

export type BadgeStanding = {
  /** Active time credited from every settled session, back to the first shift. */
  activeMs: number;
  firstTrackedAt: Date | null;
  awards: BadgeAward[];
};

/** Everything the profile card shows, short of drawing it. */
export type ProfileData = {
  robloxUsername: string;
  rank: { name: string; number: number } | null;
  /** The Roblox headshot as PNG bytes, or null when Roblox had none to give. */
  avatar: Buffer | null;
  stats: ProfileStats | null;
  standing: BadgeStanding;
};

export type TrackingOverview = {
  settings: RuntimeSettings;
  liveSessions: number;
  /** Live sessions past their heartbeat deadline plus the sweep's grace. */
  overdueSessions: number;
  lastEventAt: Date | null;
};

/** What the session commands ask of the server half. */
export interface SessionsServerPort {
  /** Brings one session's messages up to date: the Refresh button. */
  refresh(sessionId: string): Promise<void>;
  /** The member `/session view` names, tracked or only Bloxlink-mapped. Throws when neither. */
  historySubject(discordUserId: string): Promise<HistorySubject>;
  /** A member's live session. Throws a user-facing reason when there is none. */
  liveSessionFor(discordUserId: string, isSelf: boolean): Promise<SessionDetail>;
  /** Everybody on shift right now, longest-running first. */
  liveRoster(): Promise<LiveSession[]>;
  /** One session for the "More info" button. Throws when it is gone. */
  sessionDetails(sessionId: string): Promise<SessionDetail>;
  /** A tracked identity's sessions, newest first, or null when it is gone. */
  history(identityId: string): Promise<SessionHistory | null>;
  /** A completed session that may be managed by hand. Throws when it may not. */
  manageableSession(sessionId: string): Promise<ManagedSession>;
  /** Reconnecting time an edit has to keep, for a session that may be edited. */
  editableSession(sessionId: string): Promise<{ reconnectMilliseconds: number }>;
  addManualSession(input: ManualSessionInput): Promise<{ id: string; robloxUsername: string }>;
  /** Returns whose session it was and how long it was before the edit. */
  editEndedSession(input: EditSessionInput): Promise<{ robloxUsername: string; beforeMs: number }>;
  removeSession(sessionId: string, actorDiscordId: string): Promise<{ robloxUsername: string; totalMs: number }>;
  /** When the oldest session on record started, or null before the first one. */
  firstRecordedSession(): Promise<Date | null>;
  leaderboard(startDate: string, endDate: string, minimum: number): Promise<LeaderboardRow[]>;
  /** A member's profile card data. Throws a user-facing reason when they are untracked. */
  profile(discordUserId: string, isSelf: boolean): Promise<ProfileData>;
  /** The caller's badge progress for `/badges`, or null when nothing is known about them. */
  badgeGuide(discordUserId: string): Promise<{ robloxUsername: string; standing: BadgeStanding } | null>;
  trackingOverview(): Promise<TrackingOverview>;
  setLogsChannel(channelId: string): Promise<void>;
  setStaffChannel(channelId: string): Promise<void>;
  setTrackingEnabled(enabled: boolean): Promise<void>;
}

// ---------------------------------------------------------------- Server → bot

/** The full, permanent record of a shift in the logs channel. */
export type SessionRecordView = {
  kind: "record";
  sessionId: string;
  identityId: string;
  state: SessionState;
  startedAt: Date;
  lastEventAt: Date;
  deletedAt: Date | null;
  rankName: string;
  placeId: bigint;
  jobId: string;
  robloxUsername: string;
  discordUserId: string | null;
  totals: Totals;
  commands: CommandActivity;
  /** Only on a finished shift: the year so far and when the one before it ended. */
  history: { reportYear: string; yearMs: number; previousEndedAt: Date | null } | null;
};

/** The short announcement in the staff chat. */
export type SessionAnnouncementView = {
  kind: "announcement";
  sessionId: string;
  state: SessionState;
  startedAt: Date;
  endedAt: Date | null;
  deletedAt: Date | null;
  robloxUsername: string;
  discordUserId: string | null;
  totals: Totals;
};

export type SessionMessageView = SessionRecordView | SessionAnnouncementView;

/**
 * What became of one message. `posted` means a new message now exists and
 * the server has to record it — claiming it when the session had none,
 * replacing the reference when the old one was gone.
 */
export type UpsertResult =
  | { status: "edited" }
  | { status: "posted"; channelId: string; messageId: string };

export type BadgeDm = {
  discordUserId: string;
  robloxUsername: string;
  awards: Array<{ badge: string; period: string }>;
  /** Credited active time, for the hours badges' sentence. */
  activeMs: number;
};

/** What the server half asks of Discord for this feature. */
export interface SessionsBotPort {
  /** Edits the message the session owns in `channelId`, or posts a new one. */
  upsertMessage(channelId: string, existing: DiscordMessageReference | null, view: SessionMessageView): Promise<UpsertResult>;
  /** Takes messages down. One already gone counts as taken down. */
  removeMessages(messages: DiscordMessageReference[]): Promise<void>;
  /**
   * DMs a member about badges. `unreachable` means it never can be — DMs
   * closed, or no such user — so the awards count as told. Any other failure
   * throws and the awards stay owed.
   */
  sendBadgeDm(dm: BadgeDm): Promise<"sent" | "unreachable" | "skipped">;
}
