/**
 * The board <-> forum contract.
 *
 * Kanban columns are Taiga user story statuses; forum tags are Discord forum
 * tags. Everything here is name-based and case-insensitive so renaming a column
 * in Taiga only needs a change in this file.
 */

export const TaigaColumn = {
  SUGGESTED: "Suggested",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  IN_GAME: "In game",
} as const;

export const ForumTag = {
  NEW: "New",
  APPROVED: "Approved",
  IN_PROGRESS: "In progress",
  DECLINED: "Declined",
} as const;

/** Every column the bot expects to exist on the board. */
export const KNOWN_COLUMNS: string[] = Object.values(TaigaColumn);

/** Every forum tag the bot expects to exist in both forums. */
export const KNOWN_FORUM_TAGS: string[] = Object.values(ForumTag);

/** The column new posts land in. */
export const INITIAL_COLUMN: string = TaigaColumn.SUGGESTED;

/** Tags applied when a card is deleted from any column except "In game". */
export const DECLINED_TAGS: string[] = [ForumTag.DECLINED];

const COLUMN_TAGS = new Map<string, string[]>([
  [TaigaColumn.SUGGESTED, [ForumTag.NEW]],
  [TaigaColumn.PLANNED, [ForumTag.APPROVED, ForumTag.IN_PROGRESS]],
  [TaigaColumn.IN_PROGRESS, [ForumTag.APPROVED, ForumTag.IN_PROGRESS]],
  [TaigaColumn.DONE, [ForumTag.APPROVED]],
  [TaigaColumn.IN_GAME, [ForumTag.APPROVED]],
].map(([column, tags]) => [normalize(column as string), tags as string[]]));

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function sameName(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

/**
 * The exact tag set a post should carry for a column, or null when the column
 * is not one the bot knows — an unknown column must leave the post untouched
 * rather than guess.
 */
export function tagsForColumn(columnName: string): string[] | null {
  return COLUMN_TAGS.get(normalize(columnName)) ?? null;
}

export function isKnownColumn(columnName: string): boolean {
  return COLUMN_TAGS.has(normalize(columnName));
}

/** "In game" is the shipped column: deleting a card there is board cleanup, not a rejection. */
export function isShippedColumn(columnName: string): boolean {
  return sameName(columnName, TaigaColumn.IN_GAME);
}

/** Posts in a terminal state get archived: declined ones and shipped ones. */
export function shouldArchiveForColumn(columnName: string): boolean {
  return isShippedColumn(columnName);
}
