import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { UserFacingError, userError } from "../../../../core/errors.js";
import { BRAND_COLOR, SUCCESS_COLOR } from "../../../../shared/discord/colors.js";
import type { InteractionOutcome } from "../../../../shared/discord/interaction-log.js";
import { PermissionLevel } from "../../../../shared/permissions.js";
import { commandActivityDuring, type CommandActivity } from "../../../../shared/staff-activity.js";
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

/**
 * The Adonis commands run during a shift. A shift still running is asked about
 * up to this moment, so the reply counts everything typed so far.
 */
async function commandsDuring(
  ctx: SessionCommandContext,
  session: { startedAt: Date; endedAt: Date | null; identity: { robloxUserId: bigint } },
): Promise<CommandActivity> {
  return commandActivityDuring(ctx.db, {
    robloxUserId: session.identity.robloxUserId,
    from: session.startedAt,
    to: session.endedAt ?? new Date(),
  });
}

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
  if ("discordUserId" in subject && !await ctx.bloxlink.robloxForDiscord(subject.discordUserId)) {
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

/** A completed session that may be edited or removed by hand, or a user error. */
async function manageableSession(ctx: SessionCommandContext, id: string) {
  const session = await ctx.db.session.findUnique({ where: { id }, include: { identity: true } });
  if (!session || session.deletedAt) userError("Session not found");
  if (session.state !== "ENDED") userError("Live sessions cannot be managed");
  if (!recordedTimeMeetsSessionMinimum(session.activeMilliseconds, session.inactiveMilliseconds)) userError("Session not found");
  return session;
}

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
  const session = await manageableSession(ctx, id);
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
  let identity = await ctx.db.identity.findFirst({ where: { discordUserId: user.id } });
  if (!identity) {
    const mapped = await ctx.bloxlink.robloxForDiscord(user.id);
    if (!mapped) userError("That member hasn't linked a Roblox account with Bloxlink yet");
    identity = await ctx.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
  }
  return replyHistory(ctx, interaction, identity ? { identityId: identity.id } : { discordUserId: user.id }, "public");
}

export async function showActive(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  await interaction.deferReply();
  const target = interaction.options.getUser("user");
  if (!target) return replyActiveRoster(ctx, interaction);
  const isSelf = target.id === interaction.user.id;
  if (!isSelf) {
    await ctx.requirePermission(interaction, PermissionLevel.ADMIN, "Admin role required to view another member's active session");
  }
  let identity = await ctx.db.identity.findFirst({ where: { discordUserId: target.id } });
  if (!identity) {
    // No local record yet — that only exists once we've tracked a session for
    // them. Resolve via Bloxlink so we can tell "never verified" apart from
    // "verified but never tracked / not in game right now".
    const mapped = await ctx.bloxlink.robloxForDiscord(target.id);
    if (!mapped) userError(isSelf ? "You haven't linked a Roblox account with Bloxlink yet" : "That member hasn't linked a Roblox account with Bloxlink yet");
    identity = await ctx.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
  }
  if (!identity) userError(isSelf ? "You have no active session right now" : "That member has no active session right now");
  const session = await ctx.db.session.findFirst({
    where: { identityId: identity.id, state: { not: "ENDED" }, deletedAt: null },
    include: { segments: true, identity: true },
    orderBy: { startedAt: "desc" },
  });
  if (!session) userError(isSelf ? "You have no active session right now" : `${identity.robloxUsername} has no active session right now`);
  const commands = await commandsDuring(ctx, session);
  await interaction.editReply({ embeds: [sessionDetailEmbed({ ...session, commands })] });
  return { did: `sent ${identity.robloxUsername}'s live session`, fields: { state: session.state, commands: commands.total } };
}

/**
 * Every session running right now. This is what `/session active` answers with
 * when no member is named, so staff can see who is on shift at this moment.
 */
async function replyActiveRoster(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  const now = new Date();
  const sessions = await ctx.db.session.findMany({
    where: { state: { not: "ENDED" }, deletedAt: null },
    include: { identity: true, segments: true },
    orderBy: { startedAt: "asc" },
  });
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
  const session = await ctx.db.session.findUnique({ where: { id }, include: { identity: true, segments: true } });
  if (!session || session.deletedAt) userError("Session not found");
  const commands = await commandsDuring(ctx, session);
  await interaction.editReply({ embeds: [sessionDetailEmbed({ ...session, commands })] });
  return {
    did: `sent the details of ${session.identity.robloxUsername}'s session privately`,
    fields: { sessionId: id, state: session.state, commands: commands.total },
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
  let identity;
  if ("identityId" in subject) {
    identity = await ctx.db.identity.findUnique({ where: { id: subject.identityId } });
    if (!identity) userError("That member is no longer tracked");
  } else {
    const mapped = await ctx.bloxlink.robloxForDiscord(subject.discordUserId);
    if (!mapped) userError("That Discord user has no Bloxlink mapping");
    identity = await ctx.db.identity.upsert({
      where: { robloxUserId: mapped.userId },
      create: { robloxUserId: mapped.userId, robloxUsername: mapped.username, discordUserId: subject.discordUserId },
      update: { robloxUsername: mapped.username, discordUserId: subject.discordUserId },
    });
  }
  const identityId = identity.id;
  const session = await ctx.db.$transaction(async (tx) => {
    const created = await tx.session.create({ data: {
      identityId, state: "ENDED", startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end,
      activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), rankNumber: ctx.config.ROBLOX_MIN_RANK,
      rankName: "Manual entry", universeId: ctx.config.ROBLOX_UNIVERSE_ID, placeId: ctx.config.ROBLOX_ALLOWED_PLACE_IDS[0]!, jobId: "manual",
    } });
    const activeEnd = new Date(start.getTime() + active);
    if (active) await tx.timeSegment.create({ data: { sessionId: created.id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
    if (inactive) await tx.timeSegment.create({ data: { sessionId: created.id, state: "INACTIVE", startedAt: activeEnd, endedAt: end } });
    await tx.auditEntry.create({ data: { sessionId: created.id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_ADD", note: accepted.input.note } });
    return created;
  });
  await ctx.publisher.refresh(session.id);
  const added = {
    embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle("✅ Session added").setDescription(`A completed session was added for **${identity.robloxUsername}**.`).addFields(
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
    did: `added a ${friendlyDuration(active + inactive)} session for ${identity.robloxUsername}`,
    fields: { sessionId: session.id, active: friendlyDuration(active), inactive: friendlyDuration(inactive) },
  };
}

export async function editEnded(ctx: SessionCommandContext, interaction: ModalSubmitInteraction): Promise<InteractionOutcome> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const id = interaction.customId.slice("editended:".length);
  const current = await ctx.db.session.findUnique({ where: { id }, include: { identity: true } });
  if (!current || current.state !== "ENDED" || current.deletedAt) userError("Completed session not found");
  // Old rows can carry reconnecting time; it stays as it was and active time absorbs the rest.
  const reconnect = Number(current.reconnectMilliseconds);
  const accepted = await acceptForm(interaction, (input) => buildManualSession(input, ctx.config.REPORT_TIMEZONE, new Date(), reconnect));
  if ("rejected" in accepted) return { did: `rejected the edit form: ${accepted.rejected}`, fields: { sessionId: id } };
  const { start, end, activeMs: active, inactiveMs: inactive } = accepted.session;
  assertDurationInvariant(start, end, active, inactive + reconnect);
  await ctx.db.$transaction(async (tx) => {
    await tx.timeSegment.deleteMany({ where: { sessionId: id } }); const activeEnd = new Date(start.getTime() + active);
    if (active) await tx.timeSegment.create({ data: { sessionId: id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
    const inactiveEnd = new Date(activeEnd.getTime() + inactive);
    if (inactive) await tx.timeSegment.create({ data: { sessionId: id, state: "INACTIVE", startedAt: activeEnd, endedAt: inactiveEnd } });
    if (reconnect) await tx.timeSegment.create({ data: { sessionId: id, state: "RECONNECTING", startedAt: inactiveEnd, endedAt: end } });
    await tx.session.update({ where: { id }, data: { startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end, activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), reconnectMilliseconds: BigInt(reconnect) } });
    await tx.auditEntry.create({ data: {
      sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_ENDED",
      note: accepted.input.note,
      before: { startedAt: current.startedAt, endedAt: current.endedAt, activeMilliseconds: current.activeMilliseconds.toString(), inactiveMilliseconds: current.inactiveMilliseconds.toString(), reconnectMilliseconds: current.reconnectMilliseconds.toString() },
      after: { startedAt: start, endedAt: end, activeMilliseconds: String(active), inactiveMilliseconds: String(inactive), reconnectMilliseconds: String(reconnect) },
    } });
  });
  await ctx.publisher.refresh(id);
  // The form is opened from the manage panel, so show the new values there.
  const panel = { ...managePanel(await manageableSession(ctx, id), "✅ Session updated"), content: "" };
  if (interaction.isFromMessage()) await interaction.update(panel);
  else await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
  const before = Number(current.activeMilliseconds + current.inactiveMilliseconds);
  return {
    did: `edited ${current.identity.robloxUsername}'s session from ${friendlyDuration(before)} to ${friendlyDuration(active + inactive)}`,
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
  const session = await manageableSession(ctx, id);
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
  const current = await ctx.db.session.findUnique({ where: { id }, include: { identity: true } });
  if (!current || current.deletedAt) userError("Session not found");
  if (current.state !== "ENDED") userError("Live sessions cannot be managed");
  const now = new Date();
  await ctx.db.$transaction(async (tx) => {
    await tx.session.update({ where: { id }, data: { deletedAt: now } });
    await tx.auditEntry.create({ data: {
      sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_REMOVE",
      before: { deletedAt: null }, after: { deletedAt: now },
    } });
  });
  await ctx.publisher.refresh(id, true);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle("🗑️ Session removed").setDescription(`Session \`${id}\` no longer counts towards any statistics.`)],
    components: [],
  });
  return {
    did: `removed ${current.identity.robloxUsername}'s ${friendlyDuration(Number(current.activeMilliseconds + current.inactiveMilliseconds))} session`,
    fields: { sessionId: id },
  };
}
