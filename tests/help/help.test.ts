import { describe, expect, it } from "vitest";
import { helpEmbed } from "../../src/features/help/discord/handler.js";
import type { HelpSection } from "../../src/shared/discord/help.js";
import { PermissionLevel } from "../../src/shared/permissions.js";

const sections: HelpSection[] = [
  {
    title: "Sessions",
    emoji: "🎮",
    commands: [
      { usage: "/leaderboard", description: "Ranks staff.", permission: PermissionLevel.EVERYONE },
      { usage: "/session add user", description: "Adds a session.", permission: PermissionLevel.ADMIN },
    ],
  },
  {
    title: "Configuration",
    emoji: "⚙️",
    commands: [
      { usage: "/config", description: "Opens the panel.", permission: PermissionLevel.MANAGER },
    ],
  },
];

describe("/help", () => {
  it("marks what the caller can run and what needs a higher role", () => {
    const embed = helpEmbed(sections, PermissionLevel.STAFF).toJSON();
    const listed = embed.fields?.map((field) => field.value).join("\n") ?? "";
    expect(listed).toContain("✅ `/leaderboard`");
    expect(listed).toContain("🔒 `/session add user`");
    expect(listed).toContain("🔒 `/config`");
    expect(embed.description).toContain("**1** of these commands");
  });

  it("counts every command for a manager", () => {
    const embed = helpEmbed(sections, PermissionLevel.MANAGER).toJSON();
    expect(embed.description).toContain("**3** of these commands");
    expect(embed.fields?.map((field) => field.name)).toEqual(["🎮 Sessions", "⚙️ Configuration"]);
  });
});
