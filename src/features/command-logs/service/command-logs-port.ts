import type { CommandLogThread } from "@prisma/client";
import { userError } from "../../../core/errors.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { accessNotice } from "../domain/notices.js";
import type { StoredStaff } from "../domain/roster.js";
import { MINIMUM_RESTORE_LEVEL, levelForGroupRank, minimumPresserLevel, tierName } from "../domain/staff-ladder.js";
import type { CommandLogsServerPort, PanelPress } from "../link.js";
import type { CommandLogService } from "./command-log-service.js";
import type { GroupRankService } from "./group-rank.js";
import type { CommandLogPublisher } from "./publisher.js";
import type { CommandLogSettingsService } from "./settings.js";

export type CommandLogsPortDeps = {
  service: CommandLogService;
  settings: CommandLogSettingsService;
  /** Only the presses need these; the `/config` page does not. */
  publisher?: CommandLogPublisher;
  bloxlink?: BloxlinkService;
  ranks?: GroupRankService;
};

/**
 * What the panels and the `/config` page ask of the server half: moving
 * somebody's command access, and the feature's settings.
 *
 * Authority over a press comes from the staff group, not from Discord roles:
 * the tier being acted on is what Adonis gave that person in game, so the
 * presser's has to be resolved the same way — Bloxlink to a Roblox account,
 * then the group rank. Both lookups are this half's.
 */
export function commandLogsServerPort(deps: CommandLogsPortDeps): CommandLogsServerPort {
  const { service, settings } = deps;

  function pressing() {
    const { publisher, bloxlink, ranks } = deps;
    if (!publisher || !bloxlink || !ranks) throw new Error("Panel presses need the publisher, Bloxlink and the group rank lookup");
    return { publisher, bloxlink, ranks };
  }

  /** Whether the presser holds `required`, refusing the press if not. */
  async function requireLevel(press: PanelPress, required: number): Promise<void> {
    const { bloxlink, ranks } = pressing();
    const mapping = await bloxlink.robloxForDiscord(press.presser.discordUserId);
    if (!mapping) userError("Your Discord account is not linked to a Roblox account, so your staff rank cannot be checked");
    const rank = await ranks.forUser(mapping.userId);
    if (!rank) userError(`**${mapping.username}** is not in the staff group, so your staff rank cannot be checked`);
    const level = levelForGroupRank(rank.rankNumber);
    if (level < required) {
      userError(`Your rank is ${rank.rankName} (level ${level || "none"}); ${tierName(required)} or above is required`);
    }
  }

  /** The panel that was pressed, and the staff member picked from its menu. */
  async function picked(press: PanelPress): Promise<{ server: CommandLogThread; member: StoredStaff }> {
    const server = await service.serverByPanel(press.panelMessageId);
    if (!server) userError("That server panel is no longer tracked");
    const member = service.staffOf(server).find(({ userId }) => userId === press.robloxUserId);
    // The roster moves under the panel: somebody can leave between it being
    // drawn and somebody choosing them.
    if (!member) userError("That staff member is no longer in this server");
    return { server, member };
  }

  return {
    async disableAccess(press) {
      const { publisher } = pressing();
      const { server, member } = await picked(press);
      const robloxUserId = BigInt(member.userId);
      const existing = await service.activeBlock(robloxUserId);
      if (existing) return { status: "already_blocked", username: member.username, jobId: server.jobId, expiresAt: existing.expiresAt };

      await requireLevel(press, minimumPresserLevel(member.adminLevel));
      const expiresAt = await service.block({
        robloxUserId,
        robloxUsername: member.username,
        byDiscordUserId: press.presser.discordUserId,
        byDiscordName: press.presser.username,
      });
      await publisher.refreshPanel(server.jobId);
      await publisher.notice(server.jobId, accessNotice("disabled", member.username, `<@${press.presser.discordUserId}>`, expiresAt));
      return { status: "blocked", username: member.username, jobId: server.jobId, expiresAt };
    },

    /**
     * Gives command access back before the fifteen minutes are up. Taking
     * access away follows the ladder; handing it back overrules whoever took
     * it, so it takes a Manager whatever tier the person is.
     */
    async restoreAccess(press) {
      const { publisher } = pressing();
      const { server, member } = await picked(press);
      await requireLevel(press, MINIMUM_RESTORE_LEVEL);
      const lifted = await service.unblock(BigInt(member.userId));
      await publisher.refreshPanel(server.jobId);
      if (lifted) {
        await publisher.notice(server.jobId, accessNotice("restored", member.username, `<@${press.presser.discordUserId}>`));
      }
      return { status: lifted ? "restored" : "not_blocked", username: member.username, jobId: server.jobId };
    },

    overview: async () => ({ settings: await settings.get(), stats: await service.stats() }),

    setChannel: async (channelId) => { await settings.setChannel(channelId); },

    async setEnabled(enabled) {
      if (enabled && !(await settings.get()).channelId) userError("Choose a channel before turning command logging on");
      await settings.setEnabled(enabled);
    },

    setIncludeStudio: async (includeStudio) => { await settings.setIncludeStudio(includeStudio); },
  };
}
