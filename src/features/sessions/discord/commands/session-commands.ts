import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { userError } from "../../../../core/errors.js";
import { BRAND_COLOR, SUCCESS_COLOR } from "../../../../shared/discord/colors.js";
import { textInputRow } from "../../../../shared/discord/components.js";
import { PermissionLevel } from "../../../../shared/permissions.js";
import { commandActivityDuring, type CommandActivity } from "../../../../shared/staff-activity.js";
import { assertDurationInvariant, formatDuration, totalsForPeriod } from "../../domain/accounting.js";
import { recordedTimeMeetsSessionMinimum } from "../../domain/policy.js";
import { sessionDetailEmbed, sessionOwner, statusIcon, statusLabel } from "../session-embed.js";
import type { SessionCommandContext } from "./context.js";
import { formatSessionDateTime, friendlyDuration, parseDuration, parseSessionDateTime } from "./format.js";
import { addCustomId, replyHistory, type HistorySubject } from "./history.js";

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

/** The add form, opened from the history's Add button. */
export async function showAddModal(ctx: SessionCommandContext, interaction: ButtonInteraction, subject: HistorySubject): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  if ("discordUserId" in subject && !await ctx.bloxlink.robloxForDiscord(subject.discordUserId)) {
    userError("That Discord user has no Bloxlink mapping");
  }
  const modal = new ModalBuilder().setCustomId(addCustomId(subject)).setTitle("➕ Add completed session").addComponents(
    textInputRow("start", "Start (example: 11/07/2026 14:30)"), textInputRow("end", "End (example: 11/07/2026 16:45)"),
    textInputRow("active", "Active time (example: 2h 15m)"), textInputRow("inactive", "Inactive time (example: 10m)"),
    textInputRow("note", "Reason for adding this session"),
  );
  await interaction.showModal(modal);
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
export async function showManagePanel(ctx: SessionCommandContext, interaction: StringSelectMenuInteraction): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const id = interaction.values[0];
  if (!id) userError("Choose a session");
  await interaction.reply({ ...managePanel(await manageableSession(ctx, id)), flags: MessageFlags.Ephemeral });
}

/**
 * Resolves the member a `/session view` names: their tracked identity, or —
 * when the tracker has never seen them — their Bloxlink mapping, so an Admin
 * can still add their first session.
 */
export async function showView(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const user = interaction.options.getUser("user", true);
  let identity = await ctx.db.identity.findFirst({ where: { discordUserId: user.id } });
  if (!identity) {
    const mapped = await ctx.bloxlink.robloxForDiscord(user.id);
    if (!mapped) userError("That member hasn't linked a Roblox account with Bloxlink yet");
    identity = await ctx.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
  }
  await replyHistory(ctx, interaction, identity ? { identityId: identity.id } : { discordUserId: user.id }, "public");
}

export async function showActive(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const target = interaction.options.getUser("user");
  if (!target) {
    await replyActiveRoster(ctx, interaction);
    return;
  }
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
  await interaction.editReply({ embeds: [sessionDetailEmbed({ ...session, commands: await commandsDuring(ctx, session) })] });
}

/**
 * Every session running right now. This is what `/session active` answers with
 * when no member is named, so staff can see who is on shift at this moment.
 */
async function replyActiveRoster(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<void> {
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
}

/**
 * The "More info" button on a published session message: everything
 * `/session active` would show for that one session, privately.
 */
export async function showSessionDetails(ctx: SessionCommandContext, interaction: ButtonInteraction, id: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const session = await ctx.db.session.findUnique({ where: { id }, include: { identity: true, segments: true } });
  if (!session || session.deletedAt) userError("Session not found");
  await interaction.editReply({ embeds: [sessionDetailEmbed({ ...session, commands: await commandsDuring(ctx, session) })] });
}

export async function addSession(ctx: SessionCommandContext, interaction: ModalSubmitInteraction, subject: HistorySubject): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const start = parseSessionDateTime(interaction.fields.getTextInputValue("start"), ctx.config.REPORT_TIMEZONE);
  const end = parseSessionDateTime(interaction.fields.getTextInputValue("end"), ctx.config.REPORT_TIMEZONE);
  const active = parseDuration(interaction.fields.getTextInputValue("active"));
  const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
  assertDurationInvariant(start, end, active, inactive);
  if (!recordedTimeMeetsSessionMinimum(active, inactive)) userError("A completed session must contain at least one minute of recorded time");
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
    await tx.auditEntry.create({ data: { sessionId: created.id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_ADD", note: interaction.fields.getTextInputValue("note") } });
    return created;
  });
  await ctx.publisher.refresh(session.id);
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle("✅ Session added").setDescription(`A completed session was added for **${identity.robloxUsername}**.`).addFields(
      { name: "🗓️ When", value: `<t:${Math.floor(start.getTime() / 1000)}:f> to <t:${Math.floor(end.getTime() / 1000)}:t>` },
      { name: "⏱️ Time recorded", value: `${friendlyDuration(active)} active · ${friendlyDuration(inactive)} inactive` },
      { name: "🆔 Session ID", value: `\`${session.id}\`` },
    )],
    flags: MessageFlags.Ephemeral,
  });
}

export async function editEnded(ctx: SessionCommandContext, interaction: ModalSubmitInteraction): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const id = interaction.customId.slice("editended:".length);
  const start = parseSessionDateTime(interaction.fields.getTextInputValue("start"), ctx.config.REPORT_TIMEZONE);
  const end = parseSessionDateTime(interaction.fields.getTextInputValue("end"), ctx.config.REPORT_TIMEZONE);
  const active = parseDuration(interaction.fields.getTextInputValue("active")); const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
  const current = await ctx.db.session.findUnique({ where: { id } }); if (!current || current.state !== "ENDED" || current.deletedAt) userError("Completed session not found");
  const reconnect = Number(current.reconnectMilliseconds);
  assertDurationInvariant(start, end, active, inactive + reconnect);
  if (!recordedTimeMeetsSessionMinimum(active, inactive)) userError("A completed session must contain at least one minute of recorded time");
  await ctx.db.$transaction(async (tx) => {
    await tx.timeSegment.deleteMany({ where: { sessionId: id } }); const activeEnd = new Date(start.getTime() + active);
    if (active) await tx.timeSegment.create({ data: { sessionId: id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
    const inactiveEnd = new Date(activeEnd.getTime() + inactive);
    if (inactive) await tx.timeSegment.create({ data: { sessionId: id, state: "INACTIVE", startedAt: activeEnd, endedAt: inactiveEnd } });
    if (reconnect) await tx.timeSegment.create({ data: { sessionId: id, state: "RECONNECTING", startedAt: inactiveEnd, endedAt: end } });
    await tx.session.update({ where: { id }, data: { startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end, activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), reconnectMilliseconds: BigInt(reconnect) } });
    await tx.auditEntry.create({ data: {
      sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_ENDED",
      note: interaction.fields.getTextInputValue("note"),
      before: { startedAt: current.startedAt, endedAt: current.endedAt, activeMilliseconds: current.activeMilliseconds.toString(), inactiveMilliseconds: current.inactiveMilliseconds.toString(), reconnectMilliseconds: current.reconnectMilliseconds.toString() },
      after: { startedAt: start, endedAt: end, activeMilliseconds: String(active), inactiveMilliseconds: String(inactive), reconnectMilliseconds: String(reconnect) },
    } });
  });
  await ctx.publisher.refresh(id);
  // The form is opened from the manage panel, so show the new values there.
  const panel = managePanel(await manageableSession(ctx, id), "✅ Session updated");
  if (interaction.isFromMessage()) await interaction.update(panel);
  else await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
}

export async function showEditEndedModal(ctx: SessionCommandContext, interaction: ButtonInteraction, id: string): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const session = await manageableSession(ctx, id);
  const modal = new ModalBuilder().setCustomId(`editended:${id}`).setTitle("✏️ Edit completed session").addComponents(
    textInputRow("start", "Start (example: 11/07/2026 14:30)", formatSessionDateTime(session.startedAt, ctx.config.REPORT_TIMEZONE)),
    textInputRow("end", "End (example: 11/07/2026 16:45)", formatSessionDateTime(session.endedAt!, ctx.config.REPORT_TIMEZONE)),
    textInputRow("active", "Active time (example: 2h 15m)", formatDuration(session.activeMilliseconds)),
    textInputRow("inactive", "Inactive time (example: 10m)", formatDuration(session.inactiveMilliseconds)),
    textInputRow("note", "Reason for this edit"),
  );
  await interaction.showModal(modal);
}

export async function removeSession(ctx: SessionCommandContext, interaction: ButtonInteraction, id: string): Promise<void> {
  await ctx.requirePermission(interaction, PermissionLevel.ADMIN);
  const current = await ctx.db.session.findUnique({ where: { id } }); if (!current || current.deletedAt) userError("Session not found");
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
}
