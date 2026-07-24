import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_PLACEHOLDER, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH,
  buildStoryDescription, buildStorySubject, discordThreadUrl,
} from "../../src/features/taiga/domain/story.js";

const author = { discordId: "700413620319813684", name: "maksimts" };

describe("card subject", () => {
  it("uses the post title", () => {
    expect(buildStorySubject("Elevator doors close too fast")).toBe("Elevator doors close too fast");
  });

  it("truncates an over-long title", () => {
    const subject = buildStorySubject("x".repeat(MAX_SUBJECT_LENGTH + 50));
    expect(subject).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("falls back for a blank title", () => {
    expect(buildStorySubject("   ")).toBe("Untitled post");
  });
});

describe("card description", () => {
  it("keeps the first message, a link back, and the author", () => {
    const description = buildStoryDescription({
      body: "The doors shut before you can walk in.",
      guildId: "1",
      threadId: "2",
      author,
    });
    expect(description).toContain("The doors shut before you can walk in.");
    expect(description).toContain(discordThreadUrl("1", "2"));
    expect(description).toContain("Created by: @maksimts (Discord ID 700413620319813684)");
  });

  it("says so when the post had no readable text", () => {
    const description = buildStoryDescription({ body: "   ", guildId: "1", threadId: "2", author });
    expect(description).toContain(EMPTY_BODY_PLACEHOLDER);
    expect(description).toContain("Created by: @maksimts");
  });

  it("truncates a very long post but keeps the footer intact", () => {
    const description = buildStoryDescription({ body: "y".repeat(MAX_BODY_LENGTH + 500), guildId: "1", threadId: "2", author });
    expect(description).toContain("…");
    expect(description).toContain(discordThreadUrl("1", "2"));
    expect(description).toContain("Created by: @maksimts (Discord ID 700413620319813684)");
    expect(description.length).toBeLessThan(MAX_BODY_LENGTH + 200);
  });
});
