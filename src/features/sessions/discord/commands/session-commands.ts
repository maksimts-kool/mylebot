import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { UserFacingError, userError } from "../../../../core/errors.js";
import { BRAND_COLOR, SUCCESS_COLOR } from "../../../../shared/discord/colors.js";
import type { InteractionOutcome } from "../../../../shared/discord/interaction-log.js";
import { PermissionLevel } from "../../../../shared/permissions.js";
import { assertDurationInvariant, totalsForPeriod } from "../../domain/accounting.js";
import {
  buildManualSession, clockTime, formDuration, localDate, type ManualSession, type SessionFormInput,
} from "../../domain/manual-entry.js";
import { recordedTimeMeetsSessionMinimum } from "../../domain/policy.js";
import { sessionDetailEmbed, sessionOwner, statusIcon, statusLabel } from "../session-embed.js";
import type { SessionCommandContext } from "./context.js";
import { friendlyDuration } from "./format.js";
import { addCustomId, parseAddCustomId, replyHistory, type HistorySubject } from "./history.js";
import { SessionFormDrafts, readSessionForm, retryRow, sessionFormModal } from "./session-form.js";

/** How many live sessions the roster lists before it stops and counts the rest. */
const ACTIVE_ROSTER_LIMIT = 15;

/** Answers to add/edit forms the bot rejected, waiting for "Fix and resubmit". */
const formDrafts = new SessionFormDrafts();

/** The add form, opened from the history's Add button, or refilled after a mistake. */
export async function showAddModal(
  ctx: SessionCommandContext,
  interaction: ButtonInteraction,
  subject: HistorySubject,
  values?: SessionFormInput,
): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  if ("discordUserId" in subject && !await ctx.shared.robloxForDiscord(subject.discordUserId)) {
    userError("That Discord user has no Bloxlink mapping");
  }
  await interaction.showModal(sessionFormModal({
    customId: addCustomId(subject), title: "➕ Add completed session", reasonLabel: "Reason for adding it",
    timezone: ctx.config.REPORT_TIMEZONE, now: new Date(), ...(values ? { values } : {}),
  }));
  return { did: values ? "reopened the add-session form with the rejected answers" : "opened the add-session form" };
}

/** "Fix and resubmit" on a rejected form: the same form, with what was typed. */
export async function reopenSessionForm(
  ctx: SessionCommandContext,
  interaction: ButtonInteraction,
  formId: string,
): Promise<InteractionOutcome | void> {
  const draft = formDrafts.get(interaction.user.id, formId);
  if (!draft) userError("That form has expired. Open it again from the session history.");
  const addFor = parseAddCustomId(formId);
  if (addFor) return showAddModal(ctx, interaction, addFor, draft);
  if (formId.startsWith("editended:")) return showEditEndedModal(ctx, interaction, formId.slice("editended:".length), draft);
}

/**
 * Reads a submitted add/edit form. When it is wrong, keeps the answers and says
 * what to fix next to a button that reopens the form filled in, then returns
 * what was wrong with it.
 */
async function acceptForm(
  interaction: ModalSubmitInteraction,
  build: (input: SessionFormInput) => ManualSession,
): Promise<{ input: SessionFormInput; session: ManualSession } | { rejected: string }> {
  const input = readSessionForm(interaction);
  try {
    const session = build(input);
    if (!recordedTimeMeetsSessionMinimum(session.activeMs, session.inactiveMs)) userError("A session must be at least one minute long.");
    formDrafts.forget(interaction.user.id, interaction.customId);
    return { input, session };
  } catch (error) {
    if (!(error instanceof UserFacingError)) throw error;
    formDrafts.save(interaction.user.id, interaction.customId, input);
    const reply = { content: `Error: ${error.message}`, embeds: [], components: [retryRow(interaction.customId)] };
    // Fixing it a second time replaces the last error instead of stacking another.
    if (interaction.isFromMessage() && interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update(reply);
    else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral });
    return { rejected: error.message };
  }
}

type ManagedSession = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  activeMilliseconds: bigint;
  inactiveMilliseconds: bigint;
  identity: { robloxUsername: string; discordUserId: string | null };
};

/** The private edit/remove panel for one completed session. */
function managePanel(session: ManagedSession, notice?: string): { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<ButtonBuilder>> } {
  const totals = Number(session.activeMilliseconds) + Number(session.inactiveMilliseconds);
  const embed = new EmbedBuilder().setColor(notice ? SUCCESS_COLOR : BRAND_COLOR).setTitle(notice ?? "🛠️ Manage completed session").addFields(
    { name: "👤 Staff", value: sessionOwner(session.identity), inline: false },
    { name: "🗓️ When", value: `<t:${Math.floor(session.startedAt.getTime() / 1000)}:f> to <t:${Math.floor(session.endedAt!.getTime() / 1000)}:f>`, inline: false },
    { name: "⏱️ Recorded time", value: `${friendlyDuration(totals)} total · ${friendlyDuration(Number(session.activeMilliseconds))} active`, inline: false },
    { name: "🆔 Session ID", value: `\`${session.id}\`` },
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`editended:${session.id}`).setStyle(ButtonStyle.Primary).setLabel("Edit").setEmoji("✏️"),
    new ButtonBuilder().setCustomId(`remove:${session.id}`).setStyle(ButtonStyle.Danger).setLabel("Remove").setEmoji("🗑️"),
  );
  return { embeds: [embed], components: [row] };
}

/** The history's manage menu: opens one session's panel, privately. */
export async function showManagePanel(ctx: SessionCommandContext, interaction: StringSelectMenuInteraction): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const id = interaction.values[0];
  if (!id) userError("Choose a session");
  const session = await ctx.sessions.manageableSession(id);
  await interaction.reply({ ...managePanel(session), flags: MessageFlags.Ephemeral });
  return { did: `opened the manage panel for ${session.identity.robloxUsername}'s session`, fields: { sessionId: id } };
}

/**
 * Resolves the member a `/session view` names: their tracked identity, or —
 * when the tracker has never seen them — their Bloxlink mapping, so an Admin
 * can still add their first session.
 */
export async function showView(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  await interaction.deferReply();
  const user = interaction.options.getUser("user", true);
  return replyHistory(ctx, interaction, await ctx.sessions.historySubject(user.id), "public");
}

export async function showActive(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  await interaction.deferReply();
  const target = interaction.options.getUser("user");
  if (!target) return replyActiveRoster(ctx, interaction);
  const isSelf = target.id === interaction.user.id;
  if (!isSelf) {
    await ctx.requirePermission(interaction, PermissionLevel.ADMIN, "Admin role required to view another member's active session");
  }
  const session = await ctx.sessions.liveSessionFor(target.id, isSelf);
  await interaction.editReply({ embeds: [sessionDetailEmbed(session)] });
  return { did: `sent ${session.identity.robloxUsername}'s live session`, fields: { state: session.state, commands: session.commands.total } };
}

/**
 * Every session running right now. This is what `/session active` answers with
 * when no member is named, so staff can see who is on shift at this moment.
 */
async function replyActiveRoster(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  const now = new Date();
  const sessions = await ctx.sessions.liveRoster();
  const listed = sessions.slice(0, ACTIVE_ROSTER_LIMIT).map((session) => {
    const totals = totalsForPeriod(session.segments, session.startedAt, now, now);
    return [
      `${statusIcon(session.state)} ${sessionOwner(session.identity)} — **${statusLabel(session.state)}**`,
      `🗓️ Started <t:${Math.floor(session.startedAt.getTime() / 1000)}:R> · ⏱️ ${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active`,
    ].join("\n");
  }).join("\n\n");
  const remaining = sessions.length - Math.min(sessions.length, ACTIVE_ROSTER_LIMIT);
  const description = sessions.length
    ? `${listed}${remaining ? `\n\n…and ${remaining} more.` : ""}`
    : "👥 Nobody is on shift right now.";
  const embed = new EmbedBuilder()
    .setTitle("🟢 Active sessions")
    .setDescription(description)
    .setColor(BRAND_COLOR)
    .setFooter({ text: `${sessions.length} live ${sessions.length === 1 ? "session" : "sessions"} · Name a member to see their full session` })
    .setTimestamp(now);
  await interaction.editReply({ embeds: [embed] });
  return { did: `sent the list of who is on shift`, fields: { live: sessions.length } };
}

/**
 * The "More info" button on a published session message: everything
 * `/session active` would show for that one session, privately.
 */
export async function showSessionDetails(ctx: SessionCommandContext, interaction: ButtonInteraction, id: string): Promise<InteractionOutcome> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const session = await ctx.sessions.sessionDetails(id);
  await interaction.editReply({ embeds: [sessionDetailEmbed(session)] });
  return {
    did: `sent the details of ${session.identity.robloxUsername}'s session privately`,
    fields: { sessionId: id, state: session.state, commands: session.commands.total },
  };
}

export async function addSession(
  ctx: SessionCommandContext,
  interaction: ModalSubmitInteraction,
  subject: HistorySubject,
): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const accepted = await acceptForm(interaction, (input) => buildManualSession(input, ctx.config.REPORT_TIMEZONE, new Date()));
  if ("rejected" in accepted) return { did: `rejected the add-session form: ${accepted.rejected}` };
  const { start, end, activeMs: active, inactiveMs: inactive } = accepted.session;
  assertDurationInvariant(start, end, active, inactive);
  const session = await ctx.sessions.addManualSession({
    subject, start, end, activeMs: active, inactiveMs: inactive, note: accepted.input.note, actorDiscordId: interaction.user.id,
  });
  const added = {
    embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle("✅ Session added").setDescription(`A completed session was added for **${session.robloxUsername}**.`).addFields(
      { name: "🗓️ When", value: `<t:${Math.floor(start.getTime() / 1000)}:f> to <t:${Math.floor(end.getTime() / 1000)}:t>` },
      { name: "⏱️ Time recorded", value: `${friendlyDuration(active)} active · ${friendlyDuration(inactive)} inactive` },
      { name: "🆔 Session ID", value: `\`${session.id}\`` },
    )],
    content: "",
    components: [],
  };
  // Resubmitted from an error reply: turn that reply into the confirmation.
  if (interaction.isFromMessage() && interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update(added);
  else await interaction.reply({ ...added, flags: MessageFlags.Ephemeral });
  return {
    did: `added a ${friendlyDuration(active + inactive)} session for ${session.robloxUsername}`,
    fields: { sessionId: session.id, active: friendlyDuration(active), inactive: friendlyDuration(inactive) },
  };
}

export async function editEnded(ctx: SessionCommandContext, interaction: ModalSubmitInteraction): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const id = interaction.customId.slice("editended:".length);
  // Old rows can carry reconnecting time; it stays as it was and active time absorbs the rest.
  const { reconnectMilliseconds: reconnect } = await ctx.sessions.editableSession(id);
  const accepted = await acceptForm(interaction, (input) => buildManualSession(input, ctx.config.REPORT_TIMEZONE, new Date(), reconnect));
  if ("rejected" in accepted) return { did: `rejected the edit form: ${accepted.rejected}`, fields: { sessionId: id } };
  const { start, end, activeMs: active, inactiveMs: inactive } = accepted.session;
  assertDurationInvariant(start, end, active, inactive + reconnect);
  const edited = await ctx.sessions.editEndedSession({
    sessionId: id, start, end, activeMs: active, inactiveMs: inactive, note: accepted.input.note, actorDiscordId: interaction.user.id,
  });
  // The form is opened from the manage panel, so show the new values there.
  const panel = { ...managePanel(await ctx.sessions.manageableSession(id), "✅ Session updated"), content: "" };
  if (interaction.isFromMessage()) await interaction.update(panel);
  else await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
  return {
    did: `edited ${edited.robloxUsername}'s session from ${friendlyDuration(edited.beforeMs)} to ${friendlyDuration(active + inactive)}`,
    fields: { sessionId: id },
  };
}

/** A form holds a start and an end time of day, so it can describe anything shorter than a day. */
const FORM_MAX_LENGTH_MS = 24 * 3_600_000;

export async function showEditEndedModal(
  ctx: SessionCommandContext,
  interaction: ButtonInteraction,
  id: string,
  values?: SessionFormInput,
): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const session = await ctx.sessions.manageableSession(id);
  const timezone = ctx.config.REPORT_TIMEZONE;
  if (session.endedAt!.getTime() - session.startedAt.getTime() >= FORM_MAX_LENGTH_MS) {
    userError("This session is a day or longer, which the edit form can't describe. It can only be removed.");
  }
  await interaction.showModal(sessionFormModal({
    customId: `editended:${id}`, title: "✏️ Edit completed session", reasonLabel: "Reason for this edit", timezone, now: new Date(),
    values: values ?? {
      date: localDate(session.startedAt, timezone),
      start: clockTime(session.startedAt, timezone),
      end: clockTime(session.endedAt!, timezone),
      inactive: formDuration(Number(session.inactiveMilliseconds)),
    },
  }));
  return {
    did: `opened the edit form for ${session.identity.robloxUsername}'s session${values ? " with the rejected answers" : ""}`,
    fields: { sessionId: id },
  };
}

export async function removeSession(ctx: SessionCommandContext, interaction: ButtonInteraction, id: string): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const removed = await ctx.sessions.removeSession(id, interaction.user.id);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle("🗑️ Session removed").setDescription(`Session \`${id}\` no longer counts towards any statistics.`)],
    components: [],
  });
  return {
    did: `removed ${removed.robloxUsername}'s ${friendlyDuration(removed.totalMs)} session`,
    fields: { sessionId: id },
  };
}
