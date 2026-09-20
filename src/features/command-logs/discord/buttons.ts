import { Events, MessageFlags, type ButtonInteraction, type Client } from "discord.js";
import { UserFacingError, errorType, userError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { BLOCK_MINUTES } from "../domain/policy.js";
import { levelForGroupRank, minimumPresserLevel, tierName } from "../domain/staff-ladder.js";
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
 * Whether this person may take command access away from that run.
 *
 * Authority comes from the staff group, not from Discord roles: the runner's
 * tier is what Adonis gave them in game, so the presser's has to be resolved
 * the same way — Bloxlink to a Roblox account, then the group rank to a tier.
 * Anything less than one tier above the run is refused.
 */
async function requireAuthority(
  interaction: ButtonInteraction,
  deps: CommandLogButtonDeps,
  runnerLevel: number,
): Promise<number> {
  const mapping = await deps.bloxlink.robloxForDiscord(interaction.user.id);
  if (!mapping) userError("Your Discord account is not linked to a Roblox account, so your staff rank cannot be checked");
  const rank = await deps.ranks.forUser(mapping.userId);
  if (!rank) userError(`**${mapping.username}** is not in the staff group, so your staff rank cannot be checked`);
  const level = levelForGroupRank(rank.rankNumber);
  const required = minimumPresserLevel(runnerLevel);
  if (level < required) {
    userError(`Your rank is ${rank.rankName} (level ${level || "none"}); ${tierName(required)} or above is required`);
  }
  return level;
}

async function disableAccess(interaction: ButtonInteraction, entryId: string, deps: CommandLogButtonDeps): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const entry = await deps.service.entry(entryId);
  if (!entry) userError("That command run is no longer on record");

  const existing = await deps.service.blockFor(entry.robloxUserId);
  if (existing) {
    await interaction.editReply(`**${entry.robloxUsername}** already has no command access until <t:${Math.floor(existing.getTime() / 1000)}:t>`);
    return;
  }

  await requireAuthority(interaction, deps, entry.adminLevel);
  const presser = interaction.user.username;
  const expiresAt = await deps.service.block({
    robloxUserId: entry.robloxUserId,
    robloxUsername: entry.robloxUsername,
    byDiscordUserId: interaction.user.id,
    byDiscordName: presser,
    entryId: entry.id,
  });
  await deps.publisher.refresh(entry, expiresAt, `<@${interaction.user.id}>`);
  await interaction.editReply(
    `**${entry.robloxUsername}** cannot run Adonis commands for ${BLOCK_MINUTES} minutes, in every server. `
    + `Access comes back <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.`,
  );
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
    if (!parsed || parsed.action !== ACTIONS.disable) return;
    void disableAccess(interaction, parsed.entryId, deps).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError
        ? error.message
        : "The request could not be completed. Please try again later.";
      if (!(error instanceof UserFacingError)) {
        deps.log.error({
          category: "command", actor: interaction.user.username, err: error, errorType: errorType(error),
          customId: interaction.customId,
        }, "Disabling command access failed");
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
