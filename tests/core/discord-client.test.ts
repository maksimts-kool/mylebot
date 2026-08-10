import { ActivityType } from "discord.js";
import { describe, expect, it } from "vitest";
import { botPresence } from "../../src/core/discord-client.js";

describe("bot presence", () => {
  it("shows the application version in the custom status", () => {
    expect(botPresence("1.2.3")).toEqual({
      activities: [{ name: "Custom Status", state: "Running on v1.2.3", type: ActivityType.Custom }],
      status: "online",
    });
  });
});
