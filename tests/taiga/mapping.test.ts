import { describe, expect, it } from "vitest";
import {
  DECLINED_TAGS, ForumTag, INITIAL_COLUMN, KNOWN_COLUMNS, TaigaColumn,
  isKnownColumn, isShippedColumn, shouldArchiveForColumn, tagsForColumn,
} from "../../src/features/taiga/domain/mapping.js";

describe("column to forum tag mapping", () => {
  it("tags a suggested card as New only", () => {
    expect(tagsForColumn(TaigaColumn.SUGGESTED)).toEqual([ForumTag.NEW]);
  });

  it("tags planned and in-progress cards as Approved plus In progress", () => {
    expect(tagsForColumn(TaigaColumn.PLANNED)).toEqual([ForumTag.APPROVED, ForumTag.IN_PROGRESS]);
    expect(tagsForColumn(TaigaColumn.IN_PROGRESS)).toEqual([ForumTag.APPROVED, ForumTag.IN_PROGRESS]);
  });

  it("leaves only Approved once a card is done or in game", () => {
    expect(tagsForColumn(TaigaColumn.DONE)).toEqual([ForumTag.APPROVED]);
    expect(tagsForColumn(TaigaColumn.IN_GAME)).toEqual([ForumTag.APPROVED]);
  });

  it("declines with the Declined tag alone", () => {
    expect(DECLINED_TAGS).toEqual([ForumTag.DECLINED]);
  });

  it("matches column names regardless of case and padding", () => {
    expect(tagsForColumn("  in PROGRESS ")).toEqual([ForumTag.APPROVED, ForumTag.IN_PROGRESS]);
    expect(isKnownColumn("in game")).toBe(true);
  });

  it("refuses to guess for a column it does not know", () => {
    expect(tagsForColumn("Backlog")).toBeNull();
    expect(isKnownColumn("Backlog")).toBe(false);
  });

  it("starts new posts in the suggested column", () => {
    expect(INITIAL_COLUMN).toBe(TaigaColumn.SUGGESTED);
    expect(KNOWN_COLUMNS).toContain(INITIAL_COLUMN);
  });
});

describe("terminal states", () => {
  it("treats only In game as shipped", () => {
    expect(isShippedColumn(TaigaColumn.IN_GAME)).toBe(true);
    expect(isShippedColumn(TaigaColumn.DONE)).toBe(false);
    expect(isShippedColumn(TaigaColumn.SUGGESTED)).toBe(false);
  });

  it("archives shipped posts but leaves work-in-progress posts open", () => {
    expect(shouldArchiveForColumn(TaigaColumn.IN_GAME)).toBe(true);
    expect(shouldArchiveForColumn(TaigaColumn.DONE)).toBe(false);
    expect(shouldArchiveForColumn(TaigaColumn.PLANNED)).toBe(false);
  });
});
