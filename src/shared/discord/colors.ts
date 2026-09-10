/**
 * The server's main embed colour. Every embed that has no status of its own —
 * leaderboards, histories, panels — uses this instead of Discord's default
 * grey, so the bot reads as one surface. Change it here and every embed follows.
 */
export const BRAND_COLOR = 0x5865f2;

/** Neutral colour for a finished, no-longer-live record. */
export const ENDED_COLOR = BRAND_COLOR;

/** Live session status colours. */
export const ACTIVE_COLOR = 0x22c55e;
export const INACTIVE_COLOR = 0xf59e0b;

/** Affirmative and destructive accents for confirmation embeds. */
export const SUCCESS_COLOR = 0x22c55e;
export const DANGER_COLOR = 0xed4245;
export const WARNING_COLOR = 0xfee75c;
