import { Events, MessageFlags, type Client, type StringSelectMenuInteraction } from "discord.js";
import type { CommandLogThread } from "@prisma/client";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { BLOCK_MINUTES } from "../domain/policy.js";
import type { StoredStaff } from "../domain/roster.js";
import { MINIMUM_RESTORE_LEVEL, levelForGroupRank, minimumPresserLevel, tierName } from "../domain/staff-ladder.js";
import type { CommandLogService } from "../service/command-log-service.js";
import type { GroupRankService } from "../service/group-rank.js";
import type { CommandLogPublisher } from "./publisher.js";
import { PANEL_ACTIONS, accessNotice, parsePanelCustomId } from "./server-panel.js";

export type CommandLogInteractionDeps = {
  service: CommandLogService;
  publisher: CommandLogPublisher;
  bloxlink: BloxlinkService;
  ranks: GroupRankService;
  log: Logger;
};

/**
 * Whether this person holds `required`, and refuses the press if not.
 *
 * Authority comes from the staff group, not from Discord roles: the tier being
 * acted on is what Adonis gave that person in game, so the presser's has to be
 * resolved the same way — Bloxlink to a Roblox account, then the group rank.
 */
async function requireLevel(
  interaction: StringSelectMenuInteraction,
  deps: CommandLogInteractionDeps,
  required: number,
): Promise<void> {
  const mapping = await deps.bloxlink.robloxForDiscord(interaction.user.id);
  if (!mapping) userError("Your Discord account is not linked to a Roblox account, so your staff rank cannot be checked");
  const rank = await deps.ranks.forUser(mapping.userId);
  if (!rank) userError(`**${mapping.username}** is not in the staff group, so your staff rank cannot be checked`);
  const level = levelForGroupRank(rank.rankNumber);
  if (level < required) {
    userError(`Your rank is ${rank.rankName} (level ${level || "none"}); ${tierName(required)} or above is required`);
  }
}

/** The panel that was pressed, and the staff member picked from its menu. */
async function picked(
  interaction: StringSelectMenuInteraction,
  deps: CommandLogInteractionDeps,
): Promise<{ server: CommandLogThread; member: StoredStaff }> {
  const server = await deps.service.serverByPanel(interaction.message.id);
  if (!server) userError("That server panel is no longer tracked");
  const chosen = interaction.values[0];
  const member = deps.service.staffOf(server).find(({ userId }) => userId === chosen);
  // The roster moves under the panel: somebody can leave between it being
  // drawn and somebody choosing them.
  if (!member) userError("That staff member is no longer in this server");
  return { server, member };
}

async function disableAccess(interaction: StringSelectMenuInteraction, deps: CommandLogInteractionDeps): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { server, member } = await picked(interaction, deps);
  const robloxUserId = BigInt(member.userId);

  const existing = await deps.service.activeBlock(robloxUserId);
  if (existing) {
    await interaction.editReply(`**${member.username}** already has no command access until <t:${Math.floor(existing.expiresAt.getTime() / 1000)}:t>`);
    return;
  }

  await requireLevel(interaction, deps, minimumPresserLevel(member.adminLevel));
  const expiresAt = await deps.service.block({
    robloxUserId,
    robloxUsername: member.username,
    byDiscordUserId: interaction.user.id,
    byDiscordName: interaction.user.username,
  });
  await deps.publisher.refreshPanel(server.jobId);
  await deps.publisher.notice(server.jobId, accessNotice("disabled", member.username, `<@${interaction.user.id}>`, expiresAt));
  await interaction.editReply(
    `**${member.username}** cannot run Adonis commands for ${BLOCK_MINUTES} minutes, in every server. `
    + `Access comes back <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.`,
  );
}

/**
 * Gives command access back before the fifteen minutes are up. Taking access
 * away follows the ladder; handing it back overrules whoever took it, so it
 * takes a Manager whatever tier the person is.
 */
async function restoreAccess(interaction: StringSelectMenuInteraction, deps: CommandLogInteractionDeps): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { server, member } = await picked(interaction, deps);

  await requireLevel(interaction, deps, MINIMUM_RESTORE_LEVEL);
  const lifted = await deps.service.unblock(BigInt(member.userId), {
    discordName: interaction.user.username,
    robloxUsername: member.username,
  });
  await deps.publisher.refreshPanel(server.jobId);
  if (lifted) {
    await deps.publisher.notice(server.jobId, accessNotice("restored", member.username, `<@${interaction.user.id}>`));
  }
  await interaction.editReply(lifted
    ? `**${member.username}** can run Adonis commands again.`
    : `**${member.username}** already had their command access back.`);
}

/**
 * The feature's only gateway listener. Every feature shares
 * `interactionCreate`, so anything that is not one of this feature's own
 * components is left alone.
 */
export function registerCommandLogInteractions(client: Client, deps: CommandLogInteractionDeps): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const action = parsePanelCustomId(interaction.customId);
    if (!action) return;
    const press = action === PANEL_ACTIONS.disable
      ? disableAccess
      : action === PANEL_ACTIONS.restore ? restoreAccess : null;
    if (!press) return;
    void press(interaction, deps).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError
        ? error.message
        : "The request could not be completed. Please try again later.";
      if (!(error instanceof UserFacingError)) {
        deps.log.error({
          category: "command", actor: interaction.user.username, err: error, errorType: errorType(error),
          customId: interaction.customId,
        }, "A command access press failed");
      }
      try {
        if (interaction.deferred) await interaction.editReply({ content: `Error: ${message}` });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        deps.log.error({ category: "command", err: replyError }, "Could not tell the presser why nothing happened");
      }
    });
  });
}
