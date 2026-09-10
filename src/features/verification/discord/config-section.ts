import type { Config } from "../../../core/config.js";
import {
  channelValue, configPage, configRow, countValue, field, note, refreshButton, roleValue, timeValue,
  type ConfigSectionMeta,
} from "../../../shared/discord/config-presets.js";
import type { ConfigSection, ConfigView } from "../../../shared/discord/config-section.js";
import type { VerificationService } from "../service/verification-service.js";

const META: ConfigSectionMeta = {
  id: "verification",
  label: "Verification",
  emoji: "🔐",
  description: "Unverified reminder and removal cycle, and who it currently covers.",
};

/**
 * The verification timeout page in `/config`. The channel and role come from
 * the environment, so this page reports what is configured and how the current
 * cycle stands; `/verification status` is the per-member drill-down.
 */
export function verificationConfigSection(config: Config, service: VerificationService): ConfigSection {
  async function view(): Promise<ConfigView> {
    const status = await service.status();
    const now = new Date();
    const warned = status.members.filter((member) => member.warnedAt !== null).length;
    const dueNow = status.members.filter((member) => member.warnedAt !== null
      && member.removalDueAt !== null
      && member.removalDueAt.getTime() <= now.getTime()).length;
    return configPage(META, {
      summary: [
        "Members holding the Unverified role get a reminder every three days, a final warning on day 27, and are removed three days after that warning was delivered.",
        "The channel and role are environment settings, so they cannot be changed from here.",
      ],
      fields: [
        field("Reminder channel", channelValue(config.VERIFICATION_CHANNEL_ID)),
        field("Unverified role", roleValue(config.VERIFICATION_UNVERIFIED_ROLE_ID)),
        field("👥 Unverified", countValue(status.members.length)),
        field("⚠️ Warnings sent", countValue(warned)),
        field("🚨 Removal due", countValue(dueNow)),
        note(
          "📨 Role reminder",
          status.lastReminderAt === null
            ? "❌ No successful reminder recorded yet"
            : `✅ Last sent ${timeValue(status.lastReminderAt, "R")}${status.nextReminderAt ? ` · ⏰ next ${timeValue(status.nextReminderAt, "R")}` : ""}`,
        ),
        note("Per-member detail", "Run `/verification status` for every member's warning and removal deadline."),
      ],
      rows: [configRow(refreshButton(META))],
    });
  }

  return {
    ...META,
    view,
    // Refreshing is just a re-render, so there is nothing to apply.
    apply: async () => null,
  };
}
