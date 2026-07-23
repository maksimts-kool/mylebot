import { describe, expect, it } from "vitest";
import { buildSessionActionRow } from "../src/discord/publisher.js";

function labelsFor(state: "ACTIVE" | "ENDED"): string[] {
  return buildSessionActionRow({
    id: "session-1",
    identityId: "identity-1",
    state,
    placeId: "123",
    jobId: "server-1",
  }).components.map((component) => {
    const data = component.toJSON();
    return "label" in data ? data.label : "";
  });
}

describe("session message controls", () => {
  it("offers refresh while a session is live", () => {
    expect(labelsFor("ACTIVE")).toEqual(["Join Server", "View History", "Refresh"]);
  });

  it("removes refresh after a session ends", () => {
    expect(labelsFor("ENDED")).toEqual(["View History"]);
  });
});
