import { Events, MessageFlags, type ButtonInteraction, type Client } from "discord.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { BLOCK_MINUTES } from "../domain/policy.js";
import { MINIMUM_RESTORE_LEVEL, levelForGroupRank, minimumPresserLevel, tierName } from "../domain/staff-ladder.js";
import type { CommandLogService } from "../service/command-log-service.js";
import type { GroupRankService } from "../service/group-rank.js";
import { ACTIONS, disableRequirement, parseCommandLogCustomId } from "./command-log-embed.js";
import type { CommandLogPublisher } from "./publisher.js";

export type CommandLogButtonDeps = {
  service: CommandLogService;
  publisher: CommandLogPublisher;
  bloxlink: BloxlinkService;
  ranks: GroupRankService;
  log: Logger;
};

/**
 * Whether this person holds `required`, and refuses the press if not.
 *
 * Authority comes from the staff group, not from Discord roles: the runner's
 * tier is what Adonis gave them in game, so the presser's has to be resolved
 * the same way — Bloxlink to a Roblox account, then the group rank to a tier.
 */
async function requireLevel(
  interaction: ButtonInteraction,
  deps: CommandLogButtonDeps,
  required: number,
): Promise<number> {
  const mapping = await deps.bloxlink.robloxForDiscord(interaction.user.id);
  if (!mapping) userError("Your Discord account is not linked to a Roblox account, so your staff rank cannot be checked");
  const rank = await deps.ranks.forUser(mapping.userId);
  if (!rank) userError(`**${mapping.username}** is not in the staff group, so your staff rank cannot be checked`);
  const level = levelForGroupRank(rank.rankNumber);
  if (level < required) {
    userError(`Your rank is ${rank.rankName} (level ${level || "none"}); ${tierName(required)} or above is required`);
  }
  return level;
}

async function disableAccess(interaction: ButtonInteraction, entryId: string, deps: CommandLogButtonDeps): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const entry = await deps.service.entry(entryId);
  if (!entry) userError("That command run is no longer on record");

  const existing = await deps.service.activeBlock(entry.robloxUserId);
  if (existing) {
    await interaction.editReply(`**${entry.robloxUsername}** already has no command access until <t:${Math.floor(existing.expiresAt.getTime() / 1000)}:t>`);
    return;
  }

  await requireLevel(interaction, deps, minimumPresserLevel(entry.adminLevel));
  const presser = interaction.user.username;
  const expiresAt = await deps.service.block({
    robloxUserId: entry.robloxUserId,
    robloxUsername: entry.robloxUsername,
    byDiscordUserId: interaction.user.id,
    byDiscordName: presser,
    entryId: entry.id,
  });
  await deps.publisher.refresh(entry, { blockedUntil: expiresAt, blockedBy: `<@${interaction.user.id}>` });
  await interaction.editReply(
    `**${entry.robloxUsername}** cannot run Adonis commands for ${BLOCK_MINUTES} minutes, in every server. `
    + `Access comes back <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.`,
  );
}

/**
 * Gives command access back before the fifteen minutes are up. Taking access
 * away follows the ladder; handing it back overrules whoever took it, so it
 * takes a Manager whatever tier the original run was.
 */
async function restoreAccess(interaction: ButtonInteraction, entryId: string, deps: CommandLogButtonDeps): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const entry = await deps.service.entry(entryId);
  if (!entry) userError("That command run is no longer on record");

  await requireLevel(interaction, deps, MINIMUM_RESTORE_LEVEL);
  const restoredBy = `<@${interaction.user.id}>`;
  const lifted = await deps.service.unblock(entry.robloxUserId, {
    discordName: interaction.user.username,
    robloxUsername: entry.robloxUsername,
  });
  // Somebody else may have pressed first, or the block may simply have run its
  // fifteen minutes. Either way the message should stop offering the button.
  await deps.publisher.refresh(entry, { blockedUntil: null, restoredBy });
  await interaction.editReply(lifted
    ? `**${entry.robloxUsername}** can run Adonis commands again.`
    : `**${entry.robloxUsername}** already had their command access back.`);
}

/**
 * The feature's only gateway listener. Every feature shares
 * `interactionCreate`, so anything that is not one of this feature's own
 * components is left alone.
 */
export function registerCommandLogButtons(client: Client, deps: CommandLogButtonDeps): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) return;
    const parsed = parseCommandLogCustomId(interaction.customId);
    if (!parsed) return;
    const press = parsed.action === ACTIONS.disable
      ? disableAccess
      : parsed.action === ACTIONS.restore ? restoreAccess : null;
    if (!press) return;
    void press(interaction, parsed.entryId, deps).catch(async (error: unknown) => {
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
