import { ButtonStyle, ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_MAX_ROWS, NOT_CONFIGURED, SELECT_OPTION_LIMIT, channelValue, configPage, configRow, countValue,
  enabledValue, field, note, optionSelect, problemsValue, refreshButton, roleValue, selectedChannel,
  selectedValue, textChannelSelect, timeValue, toggleButton, toggleChoice, type ConfigSectionMeta,
} from "../../src/shared/discord/config-presets.js";
import { BRAND_COLOR } from "../../src/shared/discord/colors.js";
import { permissionsSection } from "../../src/features/config/sections/permissions.js";
import { trackingSection } from "../../src/features/config/sections/tracking.js";

const META: ConfigSectionMeta = { id: "demo", label: "Demo page", emoji: "🧪", description: "A page." };

/** Link and SKU buttons carry no custom id, so every read has to be guarded. */
function customIdOf(component: object): string {
  return "custom_id" in component ? String(component.custom_id) : "";
}

function channelSelect(type: ChannelType) {
  return {
    channels: { first: () => ({ id: "channel-1", type }) },
    isChannelSelectMenu: () => true,
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => false,
  };
}

describe("configuration field values", () => {
  it("says the same thing on every page when a setting has no value", () => {
    expect(channelValue("")).toBe(NOT_CONFIGURED);
    expect(channelValue(null)).toBe(NOT_CONFIGURED);
    expect(roleValue(undefined)).toBe(NOT_CONFIGURED);
    expect(timeValue(null)).toBe(NOT_CONFIGURED);
  });

  it("renders mentions, switches, counts, and timestamps in one house style", () => {
    expect(channelValue("42")).toBe("<#42>");
    expect(roleValue("42")).toBe("<@&42>");
    expect(enabledValue(true)).toBe("🟢 Enabled");
    expect(enabledValue(false)).toBe("🔴 Disabled");
    expect(countValue(3)).toBe("**3**");
    expect(timeValue(new Date("2026-01-01T00:00:00Z"), "R")).toBe("<t:1767225600:R>");
  });

  it("reports every problem as its own warning, or confirms there are none", () => {
    expect(problemsValue([])).toBe("✅ No problems detected");
    expect(problemsValue(["One", "Two"])).toBe("⚠️ One\n⚠️ Two");
  });

  it("keeps status fields side by side and explanations full width", () => {
    expect(field("Tracking", "on").inline).toBe(true);
    expect(note("What it does", "…").inline).toBe(false);
  });
});

describe("configuration pages", () => {
  it("titles a page from the section's own emoji and label", () => {
    const embed = configPage(META, { summary: "Hello." }).embeds[0]!.toJSON();
    expect(embed.title).toBe("🧪 Demo page");
    expect(embed.description).toBe("Hello.");
    expect(embed.color).toBe(BRAND_COLOR);
  });

  it("joins a multi-line summary and carries the fields it was given", () => {
    const embed = configPage(META, { summary: ["One", "Two"], fields: [field("A", "b")] }).embeds[0]!.toJSON();
    expect(embed.description).toBe("One\nTwo");
    expect(embed.fields).toEqual([{ name: "A", value: "b", inline: true }]);
  });

  it("refuses more action rows than the panel leaves a section", () => {
    const rows = Array.from({ length: CONFIG_MAX_ROWS + 1 }, () => configRow(refreshButton(META)));
    expect(() => configPage(META, { summary: "…", rows })).toThrow(/action rows/);
  });
});

describe("configuration controls", () => {
  it("namespaces every control with its section", () => {
    const select = textChannelSelect(META, "logs", "Choose").toJSON().components[0]!;
    expect(customIdOf(select)).toBe("config:demo:logs");
    expect(customIdOf(refreshButton(META).toJSON())).toBe("config:demo:refresh");
  });

  it("offers a text channel picker only the channel types a section can post in", () => {
    const select = textChannelSelect(META, "logs", "Choose").toJSON().components[0]!;
    expect("channel_types" in select ? select.channel_types : []).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  });

  it("carries the switch's intended position in its custom id and reads it back", () => {
    const off = toggleButton(META, "toggle", true, "tracking").toJSON();
    expect(customIdOf(off)).toBe("config:demo:toggle:off");
    expect("label" in off ? off.label : "").toBe("Disable tracking");
    expect(off.style).toBe(ButtonStyle.Danger);

    const on = toggleButton(META, "toggle", false, "tracking").toJSON();
    expect(customIdOf(on)).toBe("config:demo:toggle:on");
    expect("label" in on ? on.label : "").toBe("Enable tracking");
    expect(on.style).toBe(ButtonStyle.Success);

    expect(toggleChoice("toggle:on", "toggle")).toBe(true);
    expect(toggleChoice("toggle:off", "toggle")).toBe(false);
    expect(toggleChoice("reconcile", "toggle")).toBeNull();
  });

  it("drops options past the limit Discord accepts instead of failing", () => {
    const options = Array.from({ length: SELECT_OPTION_LIMIT + 5 }, (_, index) => ({ label: `Option ${index}`, value: String(index) }));
    const menu = optionSelect(META, "pick", "Choose", options).toJSON().components[0]!;
    expect("options" in menu ? menu.options.length : 0).toBe(SELECT_OPTION_LIMIT);
  });
});

describe("reading a configuration interaction", () => {
  it("accepts the channel kinds a control asked for", () => {
    expect(selectedChannel(channelSelect(ChannelType.GuildText) as never, "text", "nope").id).toBe("channel-1");
    expect(selectedChannel(channelSelect(ChannelType.GuildAnnouncement) as never, "text", "nope").id).toBe("channel-1");
    expect(selectedChannel(channelSelect(ChannelType.GuildForum) as never, "forum", "nope").id).toBe("channel-1");
  });

  it("rejects a channel of the wrong kind with the section's own wording", () => {
    expect(() => selectedChannel(channelSelect(ChannelType.GuildForum) as never, "text", "Choose a text channel")).toThrow(/Choose a text channel/);
    expect(() => selectedChannel(channelSelect(ChannelType.GuildText) as never, "forum", "Choose a forum channel")).toThrow(/Choose a forum channel/);
  });

  it("rejects an empty selection", () => {
    const empty = {
      isRoleSelectMenu: () => true,
      isStringSelectMenu: () => false,
      isChannelSelectMenu: () => false,
      values: [] as string[],
    };
    expect(() => selectedValue(empty as never, "Choose a role")).toThrow(/Choose a role/);
  });
});

describe("every configuration page", () => {
  it("uses the panel's house style, so the pages read as one surface", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue({ trackingEnabled: true, logsChannelId: "1", staffChannelId: "" }),
    };
    const db = { permissionRole: { findMany: vi.fn().mockResolvedValue([]) } };
    const client = { guilds: { cache: { get: () => undefined } } };
    const sections = [trackingSection(settings as never), permissionsSection(db as never, client as never, "guild-1")];

    for (const section of sections) {
      const view = await section.view();
      const embed = view.embeds[0]!.toJSON();
      // The navigation menu and the page itself can never drift apart.
      expect(embed.title).toBe(`${section.emoji} ${section.label}`);
      expect(embed.color).toBe(BRAND_COLOR);
      expect(view.components.length).toBeLessThanOrEqual(CONFIG_MAX_ROWS);
      for (const row of view.components) {
        for (const component of row.toJSON().components) {
          expect(customIdOf(component)).toMatch(new RegExp(`^config:${section.id}:`));
        }
      }
    }
  });
});
