import { ActivityType, GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { botPresence, createDiscordClient } from "../../src/core/discord-client.js";

const baseEnv = {
  DATABASE_URL: "postgresql://example.invalid/db",
  ROBLOX_INGESTION_SECRET: "12345678901234567890123456789012",
  ROBLOX_UNIVERSE_ID: "100",
  ROBLOX_GROUP_ID: "200",
  ROBLOX_ALLOWED_PLACE_IDS: "300",
};

describe("bot presence", () => {
  it("shows the application version in the custom status", () => {
    expect(botPresence("1.2.3")).toEqual({
      activities: [{ name: "Custom Status", state: "Running on v1.2.3", type: ActivityType.Custom }],
      status: "online",
    });
  });
});

describe("Discord client intents", () => {
  it("requests guild members only when verification is configured", () => {
    const withoutVerification = createDiscordClient(loadConfig(baseEnv));
    expect(withoutVerification.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(false);

    const withVerification = createDiscordClient(loadConfig({
      ...baseEnv,
      DISCORD_GUILD_ID: "1068891577054933083",
      VERIFICATION_CHANNEL_ID: "1087381025291780147",
      VERIFICATION_UNVERIFIED_ROLE_ID: "1087383526078423070",
    }));
    expect(withVerification.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
  });
});
