import { Events, MessageFlags, type Client, type StringSelectMenuInteraction } from "discord.js";
import { UserFacingError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { InteractionLog, type InteractionOutcome } from "../../../shared/discord/interaction-log.js";
import { BLOCK_MINUTES } from "../domain/policy.js";
import type { CommandLogsServerPort, PanelPress } from "../link.js";
import { PANEL_ACTIONS, parsePanelCustomId } from "./server-panel.js";

function timestamp(date: Date, style: "t" | "R"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function pressOf(interaction: StringSelectMenuInteraction): PanelPress {
  return {
    panelMessageId: interaction.message.id,
    robloxUserId: interaction.values[0] ?? "",
    presser: { discordUserId: interaction.user.id, username: interaction.user.username },
  };
}

async function disableAccess(interaction: StringSelectMenuInteraction, logs: CommandLogsServerPort): Promise<InteractionOutcome> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const outcome = await logs.disableAccess(pressOf(interaction));
  if (outcome.status === "already_blocked") {
    await interaction.editReply(`**${outcome.username}** already has no command access until ${timestamp(outcome.expiresAt, "t")}`);
    return { did: `left ${outcome.username} alone, their command access is already taken away`, fields: { jobId: outcome.jobId } };
  }
  if (outcome.status !== "blocked") throw new Error(`Unexpected outcome ${outcome.status}`);
  await interaction.editReply(
    `**${outcome.username}** cannot run Adonis commands for ${BLOCK_MINUTES} minutes, in every server. `
    + `Access comes back ${timestamp(outcome.expiresAt, "R")}.`,
  );
  return { did: `took command access from ${outcome.username} for ${BLOCK_MINUTES} minutes`, fields: { jobId: outcome.jobId } };
}

async function restoreAccess(interaction: StringSelectMenuInteraction, logs: CommandLogsServerPort): Promise<InteractionOutcome> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const outcome = await logs.restoreAccess(pressOf(interaction));
  const lifted = outcome.status === "restored";
  await interaction.editReply(lifted
    ? `**${outcome.username}** can run Adonis commands again.`
    : `**${outcome.username}** already had their command access back.`);
  return {
    did: lifted ? `gave command access back to ${outcome.username}` : `left ${outcome.username} alone, they already had command access`,
    fields: { jobId: outcome.jobId },
  };
}

/**
 * The feature's only gateway listener. Every feature shares
 * `interactionCreate`, so anything that is not one of this feature's own
 * components is left alone. Who may press what is decided by the server half.
 */
export function registerCommandLogInteractions(client: Client, logs: CommandLogsServerPort, log: Logger): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const action = parsePanelCustomId(interaction.customId);
    if (!action) return;
    const press = action === PANEL_ACTIONS.disable
      ? disableAccess
      : action === PANEL_ACTIONS.restore ? restoreAccess : null;
    if (!press) return;
    const trace = new InteractionLog(interaction, log.child({ category: "command" }));
    void press(interaction, logs).then((outcome) => trace.done(outcome), async (error: unknown) => {
      trace.failed(error);
      const message = error instanceof UserFacingError
        ? error.message
        : "The request could not be completed. Please try again later.";
      try {
        if (interaction.deferred) await interaction.editReply({ content: `Error: ${message}` });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        log.error({ category: "command", err: replyError }, "Could not tell the presser why nothing happened");
      }
    });
  });
}
