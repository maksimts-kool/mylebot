import { describe, expect, it } from "vitest";
import { MAX_APPLIED_TAGS, nextAppliedTags } from "../../src/features/taiga/discord/tags.js";

// Tag ids as they come back from a forum channel.
const NEW = "tag-new";
const APPROVED = "tag-approved";
const IN_PROGRESS = "tag-in-progress";
const DECLINED = "tag-declined";
const BUG = "tag-bug";
const MANAGED = [NEW, APPROVED, IN_PROGRESS, DECLINED];

describe("choosing a post's tags", () => {
  it("keeps a category tag the bot does not manage", () => {
    expect(nextAppliedTags([BUG, NEW], [APPROVED, IN_PROGRESS], MANAGED)).toEqual([APPROVED, IN_PROGRESS, BUG]);
  });

  it("replaces the previous board state instead of stacking on it", () => {
    expect(nextAppliedTags([APPROVED, IN_PROGRESS], [APPROVED], MANAGED)).toEqual([APPROVED]);
    expect(nextAppliedTags([NEW], [DECLINED], MANAGED)).toEqual([DECLINED]);
  });

  it("preserves unmanaged tags when a post is declined", () => {
    expect(nextAppliedTags([BUG, APPROVED, IN_PROGRESS], [DECLINED], MANAGED)).toEqual([DECLINED, BUG]);
  });

  it("adds the first state to an untagged post", () => {
    expect(nextAppliedTags([], [NEW], MANAGED)).toEqual([NEW]);
  });

  it("never repeats a tag that is already applied", () => {
    expect(nextAppliedTags([BUG, APPROVED], [APPROVED], MANAGED)).toEqual([APPROVED, BUG]);
  });

  it("keeps the board state when the post is already at Discord's tag ceiling", () => {
    const extras = ["extra-1", "extra-2", "extra-3", "extra-4"];
    const result = nextAppliedTags([...extras, NEW], [APPROVED, IN_PROGRESS], MANAGED);
    expect(result).toHaveLength(MAX_APPLIED_TAGS);
    expect(result.slice(0, 2)).toEqual([APPROVED, IN_PROGRESS]);
    expect(result).not.toContain(NEW);
  });
});
