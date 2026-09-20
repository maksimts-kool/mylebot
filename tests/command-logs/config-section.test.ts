import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { UserFacingError } from "../../src/core/errors.js";
import { commandLogsConfigSection } from "../../src/features/command-logs/discord/config-section.js";
import { CONFIG_MAX_ROWS, NOT_CONFIGURED } from "../../src/shared/discord/config-presets.js";
import type { CommandLogService } from "../../src/features/command-logs/service/command-log-service.js";
import type { CommandLogSettings, CommandLogSettingsService } from "../../src/features/command-logs/service/settings.js";

function channelSelect(id: string) {
  return {
    channels: { first: () => ({ id, type: ChannelType.GuildText }) },
    isChannelSelectMenu: () => true,
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => false,
  };
}

const button = {
  isChannelSelectMenu: () => false,
  isRoleSelectMenu: () => false,
  isStringSelectMenu: () => false,
};

function build(overrides: Partial<CommandLogSettings> = {}) {
  const state: CommandLogSettings = { enabled: true, channelId: "channel-1", includeStudio: true, ...overrides };
  const settings = {
    get: vi.fn().mockResolvedValue(state),
    setChannel: vi.fn().mockResolvedValue(state),
    setEnabled: vi.fn().mockResolvedValue(state),
    setIncludeStudio: vi.fn().mockResolvedValue(state),
  } as unknown as CommandLogSettingsService;
  const service = {
    stats: vi.fn().mockResolvedValue({ servers: 3, blocks: 1, runsToday: 42 }),
  } as unknown as CommandLogService;
  return { section: commandLogsConfigSection(settings, service), settings, service };
}

describe("the command logs configuration page", () => {
  it("fits the rows the panel leaves a section", async () => {
    const { section } = build();
    const view = await section.view();
    expect(view.components.length).toBeLessThanOrEqual(CONFIG_MAX_ROWS);
  });

  it("reports the channel, the switches and what the feature has been doing", async () => {
    const { section } = build();
    const embed = (await section.view()).embeds[0]!.toJSON();
    const values = Object.fromEntries((embed.fields ?? []).map((field) => [field.name, field.value]));
    expect(values["Channel"]).toBe("<#channel-1>");
    expect(values["Logging"]).toContain("Enabled");
    expect(values["Studio playtests"]).toContain("Enabled");
    expect(values["Live servers"]).toBe("**3**");
    expect(values["Runs in 24h"]).toBe("**42**");
    expect(values["Access blocks"]).toBe("**1**");
  });

  it("warns that an unset channel leaves nowhere to post", async () => {
    const { section } = build({ channelId: "", enabled: false });
    const embed = (await section.view()).embeds[0]!.toJSON();
    const values = Object.fromEntries((embed.fields ?? []).map((field) => [field.name, field.value]));
    expect(values["Channel"]).toBe(NOT_CONFIGURED);
    expect(values["Health"]).toContain("⚠️");
  });

  it("stores the chosen channel", async () => {
    const { section, settings } = build();
    await section.apply(channelSelect("channel-2") as never, "channel");
    expect(settings.setChannel).toHaveBeenCalledWith("channel-2");
  });

  it("refuses to turn logging on before there is anywhere to post", async () => {
    const { section, settings } = build({ channelId: "", enabled: false });
    await expect(section.apply(button as never, "toggle:on")).rejects.toThrow(UserFacingError);
    expect(settings.setEnabled).not.toHaveBeenCalled();
  });

  it("switches logging and Studio playtests independently", async () => {
    const { section, settings } = build();
    await section.apply(button as never, "toggle:off");
    expect(settings.setEnabled).toHaveBeenCalledWith(false);
    await section.apply(button as never, "studio:off");
    expect(settings.setIncludeStudio).toHaveBeenCalledWith(false);
    expect(settings.setEnabled).toHaveBeenCalledTimes(1);
  });
});
