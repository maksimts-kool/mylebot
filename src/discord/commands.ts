import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder,
  GuildMember, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags, type ButtonInteraction, type Client, type Interaction,
  type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { Config } from "../config.js";
import type { prisma as database } from "../db.js";
import { assertDurationInvariant, formatDuration, totalsForPeriod } from "../domain/accounting.js";
import { buildLeaderboard, tallinnDateRange } from "../domain/reporting.js";
import type { BloxlinkService } from "../services/bloxlink.js";
import type { DiscordPublisher } from "./publisher.js";

type Db = typeof database;

export const commandData = [
  new SlashCommandBuilder().setName("session").setDescription("Manage staff sessions")
    .addSubcommand((s) => s.setName("add").setDescription("Add a completed session")
      .addStringOption((o) => o.setName("start").setDescription("When the session started (ISO date and time)").setRequired(true))
      .addStringOption((o) => o.setName("end").setDescription("When the session ended (ISO date and time)").setRequired(true))
      .addStringOption((o) => o.setName("active").setDescription("Active time, for example 2h 15m").setRequired(true))
      .addStringOption((o) => o.setName("inactive").setDescription("Inactive time, for example 10m").setRequired(true))
      .addStringOption((o) => o.setName("note").setDescription("Why this session is being added").setRequired(true))
      .addUserOption((o) => o.setName("member").setDescription("Linked Discord member"))
      .addStringOption((o) => o.setName("roblox_username").setDescription("Roblox username")))
    .addSubcommand((s) => s.setName("edit").setDescription("Correct a session")
      .addStringOption((o) => o.setName("session_id").setDescription("Session ID").setRequired(true))
      .addStringOption((o) => o.setName("start").setDescription("Corrected start date and time"))
      .addStringOption((o) => o.setName("end").setDescription("Corrected end date and time (completed sessions only)"))
      .addStringOption((o) => o.setName("active").setDescription("Corrected active time, for example 2h 15m"))
      .addStringOption((o) => o.setName("inactive").setDescription("Corrected inactive time, for example 10m"))
      .addStringOption((o) => o.setName("roblox_username").setDescription("Corrected Roblox username"))
      .addIntegerOption((o) => o.setName("rank_number").setDescription("Corrected Roblox group rank").setMinValue(0).setMaxValue(255))
      .addStringOption((o) => o.setName("rank_name").setDescription("Corrected Roblox group role name"))
      .addStringOption((o) => o.setName("note").setDescription("Why this session is being corrected")))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a session").addStringOption((o) => o.setName("session_id").setDescription("Session ID").setRequired(true)))
    .addSubcommand((s) => s.setName("view").setDescription("View session history")
      .addStringOption((o) => o.setName("session_id").setDescription("Session ID"))
      .addUserOption((o) => o.setName("member").setDescription("Discord member"))
      .addStringOption((o) => o.setName("roblox_username").setDescription("Roblox username"))),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show the staff leaderboard")
    .addStringOption((o) => o.setName("period").setDescription("Reporting period (defaults to this month)")
      .addChoices(
        { name: "This week", value: "week" },
        { name: "This month", value: "month" },
        { name: "This year", value: "year" },
        { name: "All time", value: "all" },
      )),
].map((command) => command.toJSON());

function input(id: string, label: string, value = "", required = true): ActionRowBuilder<TextInputBuilder> {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required);
  if (value) field.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}

function parseInstant(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}

function parseDuration(value: string): number {
  const match = value.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (!match || !match[0].trim() || (!match[1] && !match[2] && !match[3])) throw new Error(`Invalid duration: ${value}`);
  return ((Number(match[1] ?? 0) * 3600) + (Number(match[2] ?? 0) * 60) + Number(match[3] ?? 0)) * 1000;
}

function friendlyDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainder = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (remainder && parts.length < 2) parts.push(`${remainder} ${remainder === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

function friendlyPeriod(startDate: string, endDate: string, timezone: string): string {
  const start = DateTime.fromISO(startDate, { zone: timezone });
  const end = DateTime.fromISO(endDate, { zone: timezone });
  if (start.year === end.year && start.month === end.month) return start.toFormat("LLLL yyyy");
  if (start.year === end.year) return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d, yyyy")}`;
  return `${start.toFormat("LLL d, yyyy")} – ${end.toFormat("LLL d, yyyy")}`;
}

export class CommandHandler {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly publisher: DiscordPublisher,
    private readonly bloxlink: BloxlinkService,
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
      }
    }));
  }

  private memberRoles(interaction: Interaction): string[] {
    return interaction.member instanceof GuildMember ? [...interaction.member.roles.cache.keys()] : [];
  }

  private isAdmin(interaction: Interaction): boolean {
    if (interaction.member instanceof GuildMember && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return this.memberRoles(interaction).some((id) => this.config.DISCORD_ADMIN_ROLE_IDS.includes(id));
  }

  private async canReport(interaction: Interaction): Promise<boolean> {
    if (this.isAdmin(interaction) || this.memberRoles(interaction).some((id) => this.config.DISCORD_STAFF_ROLE_IDS.includes(id))) return true;
    const discordId = interaction.user.id;
    const identity = await this.db.identity.findFirst({ where: { discordUserId: discordId } });
    if (!identity) return false;
    const latest = await this.db.session.findFirst({ where: { identityId: identity.id, deletedAt: null }, orderBy: { startedAt: "desc" } });
    return Boolean(latest && latest.rankNumber >= this.config.ROBLOX_MIN_RANK && latest.rankNumber <= this.config.ROBLOX_MAX_RANK);
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) await this.handleCommand(interaction);
    else if (interaction.isModalSubmit()) await this.handleModal(interaction);
    else if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await this.handleSelect(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "leaderboard") {
      if (!await this.canReport(interaction)) throw new Error("You do not have permission to view leaderboards");
      const period = interaction.options.getString("period") ?? "month";
      const { startDate, endDate } = this.presetDates(period);
      await this.renderLeaderboard(interaction, startDate, endDate, 0, 0); return;
    }
    const action = interaction.options.getSubcommand();
    if (["add", "edit", "remove"].includes(action) && !this.isAdmin(interaction)) throw new Error("Administrator role required");
    if (action === "view" && !await this.canReport(interaction)) throw new Error("You do not have permission to view history");
    if (action === "add") await this.addSessionFromCommand(interaction);
    if (action === "edit") await this.editSessionFromCommand(interaction);
    if (action === "remove") await this.showRemove(interaction);
    if (action === "view") await this.showView(interaction);
  }

  private async addSessionFromCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.options.getUser("member");
    const username = interaction.options.getString("roblox_username");
    if (Boolean(member) === Boolean(username)) throw new Error("Choose exactly one Discord member or Roblox username");
    const start = parseInstant(interaction.options.getString("start", true));
    const end = parseInstant(interaction.options.getString("end", true));
    const active = parseDuration(interaction.options.getString("active", true));
    const inactive = parseDuration(interaction.options.getString("inactive", true));
    const note = interaction.options.getString("note", true);
    assertDurationInvariant(start, end, active, inactive);

    let userId: bigint;
    let robloxUsername: string;
    let discordUserId: string | null = null;
    if (member) {
      const mapped = await this.bloxlink.robloxForDiscord(member.id);
      if (!mapped) throw new Error("That Discord member has no Bloxlink mapping");
      userId = mapped.userId;
      robloxUsername = mapped.username;
      discordUserId = member.id;
    } else {
      const response = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
      });
      if (!response.ok) throw new Error("Roblox username lookup failed");
      const body = await response.json() as { data?: Array<{ id: number; name: string }> };
      const found = body.data?.[0];
      if (!found) throw new Error("Roblox user not found");
      userId = BigInt(found.id);
      robloxUsername = found.name;
    }
    const identity = await this.db.identity.upsert({
      where: { robloxUserId: userId },
      create: { robloxUserId: userId, robloxUsername, discordUserId },
      update: { robloxUsername, ...(discordUserId ? { discordUserId } : {}) },
    });
    const session = await this.db.$transaction(async (tx) => {
      const created = await tx.session.create({ data: {
        identityId: identity.id, state: "ENDED", startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end,
        activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), rankNumber: this.config.ROBLOX_MIN_RANK,
        rankName: "Manual entry", universeId: this.config.ROBLOX_UNIVERSE_ID, placeId: this.config.ROBLOX_ALLOWED_PLACE_IDS[0]!, jobId: "manual",
      } });
      const activeEnd = new Date(start.getTime() + active);
      if (active) await tx.timeSegment.create({ data: { sessionId: created.id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
      if (inactive) await tx.timeSegment.create({ data: { sessionId: created.id, state: "INACTIVE", startedAt: activeEnd, endedAt: end } });
      await tx.auditEntry.create({ data: { sessionId: created.id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_ADD", note } });
      return created;
    });
    await this.publisher.refresh(session.id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Session added").setDescription(`A completed session was added for **${robloxUsername}**.`).addFields(
        { name: "When", value: `<t:${Math.floor(start.getTime()/1000)}:f> to <t:${Math.floor(end.getTime()/1000)}:t>` },
        { name: "Time recorded", value: `${friendlyDuration(active)} active · ${friendlyDuration(inactive)} inactive` },
        { name: "Session ID", value: `\`${session.id}\`` },
      )],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async editSessionFromCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("session_id", true);
    const current = await this.db.session.findUnique({ where: { id }, include: { identity: true } });
    if (!current || current.deletedAt) throw new Error("Session not found");
    const username = interaction.options.getString("roblox_username") ?? current.identity.robloxUsername;
    const rankNumber = interaction.options.getInteger("rank_number") ?? current.rankNumber;
    const rankName = interaction.options.getString("rank_name") ?? current.rankName;
    const note = interaction.options.getString("note") ?? "Session corrected by an administrator";
    const start = interaction.options.getString("start") ? parseInstant(interaction.options.getString("start", true)) : current.startedAt;

    if (current.state !== "ENDED") {
      if (interaction.options.getString("end") || interaction.options.getString("active") || interaction.options.getString("inactive")) {
        throw new Error("Live session counters cannot be edited directly");
      }
      if (start >= current.lastStateAt) throw new Error("Start must be before the latest session update");
      await this.db.$transaction([
        this.db.identity.update({ where: { id: current.identityId }, data: { robloxUsername: username } }),
        this.db.session.update({ where: { id }, data: { startedAt: start, rankNumber, rankName } }),
        this.db.timeSegment.updateMany({ where: { sessionId: id, startedAt: current.startedAt }, data: { startedAt: start } }),
        this.db.auditEntry.create({ data: { sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_LIVE", note } }),
      ]);
    } else {
      const end = interaction.options.getString("end") ? parseInstant(interaction.options.getString("end", true)) : current.endedAt!;
      const active = interaction.options.getString("active") ? parseDuration(interaction.options.getString("active", true)) : Number(current.activeMilliseconds);
      const inactive = interaction.options.getString("inactive") ? parseDuration(interaction.options.getString("inactive", true)) : Number(current.inactiveMilliseconds + current.reconnectMilliseconds);
      assertDurationInvariant(start, end, active, inactive);
      await this.db.$transaction(async (tx) => {
        await tx.identity.update({ where: { id: current.identityId }, data: { robloxUsername: username } });
        await tx.timeSegment.deleteMany({ where: { sessionId: id } });
        const activeEnd = new Date(start.getTime() + active);
        if (active) await tx.timeSegment.create({ data: { sessionId: id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
        if (inactive) await tx.timeSegment.create({ data: { sessionId: id, state: "INACTIVE", startedAt: activeEnd, endedAt: end } });
        await tx.session.update({ where: { id }, data: { startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end, activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), reconnectMilliseconds: 0, rankNumber, rankName } });
        await tx.auditEntry.create({ data: { sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_ENDED", note } });
      });
    }
    await this.publisher.refresh(id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Session updated").setDescription(`The session for **${username}** was corrected successfully.`).addFields({ name: "Session ID", value: `\`${id}\`` })],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async showRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("session_id", true);
    const session = await this.db.session.findUnique({ where: { id }, include: { identity: true } });
    if (!session || session.deletedAt) throw new Error("Session not found");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`remove:${id}`).setStyle(ButtonStyle.Danger).setLabel("Permanently hide from statistics"),
      new ButtonBuilder().setCustomId("cancel").setStyle(ButtonStyle.Secondary).setLabel("Cancel"),
    );
    await interaction.reply({ content: `Remove session **${id}** for **${session.identity.robloxUsername}**? The audit record will be retained.`, components: [row], flags: MessageFlags.Ephemeral });
  }

  private async showView(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionId = interaction.options.getString("session_id");
    const member = interaction.options.getUser("member");
    const username = interaction.options.getString("roblox_username");
    const supplied = [sessionId, member, username].filter(Boolean);
    if (supplied.length !== 1) throw new Error("Choose exactly one lookup field");
    if (sessionId) {
      const session = await this.db.session.findUnique({ where: { id: sessionId } });
      if (!session || session.deletedAt) throw new Error("Session not found");
      await this.replyHistory(interaction, session.identityId, 0); return;
    }
    let identity = member
      ? await this.db.identity.findFirst({ where: { discordUserId: member.id } })
      : await this.db.identity.findFirst({ where: { robloxUsername: { equals: username!, mode: "insensitive" } } });
    if (!identity && member) {
      const mapped = await this.bloxlink.robloxForDiscord(member.id);
      if (mapped) identity = await this.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
    }
    if (!identity) throw new Error("Identity not found");
    await this.replyHistory(interaction, identity.id, 0);
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith("add:")) await this.addSession(interaction);
    else if (interaction.customId.startsWith("editlive:")) await this.editLive(interaction);
    else if (interaction.customId.startsWith("editended:")) await this.editEnded(interaction);
  }

  private async addSession(interaction: ModalSubmitInteraction): Promise<void> {
    const start = parseInstant(interaction.fields.getTextInputValue("start"));
    const end = parseInstant(interaction.fields.getTextInputValue("end"));
    const active = parseDuration(interaction.fields.getTextInputValue("active"));
    const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
    assertDurationInvariant(start, end, active, inactive);
    const parts = interaction.customId.slice(4).split(":");
    let userId: bigint;
    let username: string;
    let discordUserId: string | undefined;
    if (parts[0] === "id") {
      userId = BigInt(parts[1]!); username = decodeURIComponent(parts[2]!); discordUserId = parts[3];
    } else {
      username = parts.slice(1).join(":");
      const response = await fetch(`https://users.roblox.com/v1/usernames/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }) });
      if (!response.ok) throw new Error("Roblox username lookup failed");
      const body = await response.json() as { data?: Array<{ id: number; name: string }> };
      const found = body.data?.[0]; if (!found) throw new Error("Roblox user not found");
      userId = BigInt(found.id); username = found.name;
    }
    const identity = await this.db.identity.upsert({ where: { robloxUserId: userId }, create: { robloxUserId: userId, robloxUsername: username, discordUserId: discordUserId ?? null }, update: { robloxUsername: username, ...(discordUserId ? { discordUserId } : {}) } });
    const session = await this.db.$transaction(async (tx) => {
      const created = await tx.session.create({ data: {
        identityId: identity.id, state: "ENDED", startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end,
        activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), rankNumber: this.config.ROBLOX_MIN_RANK,
        rankName: "Manual entry", universeId: this.config.ROBLOX_UNIVERSE_ID, placeId: this.config.ROBLOX_ALLOWED_PLACE_IDS[0]!, jobId: "manual",
      } });
      const activeEnd = new Date(start.getTime() + active);
      if (active) await tx.timeSegment.create({ data: { sessionId: created.id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
      if (inactive) await tx.timeSegment.create({ data: { sessionId: created.id, state: "INACTIVE", startedAt: activeEnd, endedAt: end } });
      await tx.auditEntry.create({ data: { sessionId: created.id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_ADD", note: interaction.fields.getTextInputValue("note") } });
      return created;
    });
    await this.publisher.refresh(session.id);
    await interaction.reply({ content: `Created session ${session.id}.`, flags: MessageFlags.Ephemeral });
  }

  private async editLive(interaction: ModalSubmitInteraction): Promise<void> {
    const id = interaction.customId.slice("editlive:".length);
    const current = await this.db.session.findUnique({ where: { id }, include: { identity: true } });
    if (!current || current.state === "ENDED" || current.deletedAt) throw new Error("Live session not found");
    const start = parseInstant(interaction.fields.getTextInputValue("start"));
    if (start >= current.lastStateAt) throw new Error("Start must be before the last state update");
    const rankNumber = Number(interaction.fields.getTextInputValue("rankNumber"));
    if (!Number.isInteger(rankNumber) || rankNumber < 0 || rankNumber > 255) throw new Error("Rank number must be an integer from 0 to 255");
    await this.db.$transaction([
      this.db.identity.update({ where: { id: current.identityId }, data: { robloxUsername: interaction.fields.getTextInputValue("username") } }),
      this.db.session.update({ where: { id }, data: { startedAt: start, rankNumber, rankName: interaction.fields.getTextInputValue("rankName") } }),
      this.db.timeSegment.updateMany({ where: { sessionId: id, startedAt: current.startedAt }, data: { startedAt: start } }),
      this.db.auditEntry.create({ data: { sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_LIVE", note: interaction.fields.getTextInputValue("note") } }),
    ]);
    await this.publisher.refresh(id); await interaction.reply({ content: "Live session updated.", flags: MessageFlags.Ephemeral });
  }

  private async editEnded(interaction: ModalSubmitInteraction): Promise<void> {
    const id = interaction.customId.slice("editended:".length);
    const start = parseInstant(interaction.fields.getTextInputValue("start")); const end = parseInstant(interaction.fields.getTextInputValue("end"));
    const active = parseDuration(interaction.fields.getTextInputValue("active")); const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
    assertDurationInvariant(start, end, active, inactive);
    const current = await this.db.session.findUnique({ where: { id } }); if (!current || current.state !== "ENDED" || current.deletedAt) throw new Error("Completed session not found");
    await this.db.$transaction(async (tx) => {
      await tx.timeSegment.deleteMany({ where: { sessionId: id } }); const activeEnd = new Date(start.getTime() + active);
      if (active) await tx.timeSegment.create({ data: { sessionId: id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
      if (inactive) await tx.timeSegment.create({ data: { sessionId: id, state: "INACTIVE", startedAt: activeEnd, endedAt: end } });
      await tx.session.update({ where: { id }, data: { startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end, activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), reconnectMilliseconds: 0 } });
      await tx.auditEntry.create({ data: { sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_ENDED", note: interaction.fields.getTextInputValue("note") } });
    });
    await this.publisher.refresh(id); await interaction.reply({ content: "Completed session updated.", flags: MessageFlags.Ephemeral });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === "cancel") { await interaction.update({ content: "Cancelled.", components: [] }); return; }
    if (interaction.customId.startsWith("refresh:")) { const id = interaction.customId.slice(8); await this.publisher.refresh(id); await interaction.reply({ content: "Refreshed.", flags: MessageFlags.Ephemeral }); return; }
    if (interaction.customId.startsWith("history:")) { if (!await this.canReport(interaction)) throw new Error("Permission denied"); await this.replyHistory(interaction, interaction.customId.slice(8), 0); return; }
    if (interaction.customId.startsWith("historypage:")) { const [, identityId, page] = interaction.customId.split(":"); await this.replyHistory(interaction, identityId!, Number(page)); return; }
    if (interaction.customId.startsWith("leaderboard:")) {
      if (!await this.canReport(interaction)) throw new Error("Permission denied");
      const [, startDate, endDate, minimum, page] = interaction.customId.split(":");
      await this.renderLeaderboard(interaction, startDate!, endDate!, Number(minimum), Number(page)); return;
    }
    if (interaction.customId.startsWith("remove:")) {
      if (!this.isAdmin(interaction)) throw new Error("Administrator role required"); const id = interaction.customId.slice(7);
      const current = await this.db.session.findUnique({ where: { id } }); if (!current || current.deletedAt) throw new Error("Session not found");
      const now = new Date();
      await this.db.$transaction(async (tx) => {
        if (current.state !== "ENDED") { await tx.timeSegment.updateMany({ where: { sessionId: id, endedAt: null }, data: { endedAt: now } }); }
        await tx.session.update({ where: { id }, data: { state: "ENDED", endedAt: current.endedAt ?? now, deletedAt: now, reconnectDeadline: null } });
        await tx.auditEntry.create({ data: { sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_REMOVE" } });
      });
      await this.publisher.refresh(id, true);
      await interaction.update({ content: `Session ${id} removed from statistics.`, components: [] });
    }
  }

  private async replyHistory(interaction: ChatInputCommandInteraction | ButtonInteraction, identityId: string, page: number): Promise<void> {
    const pageSize = 10; const count = await this.db.session.count({ where: { identityId, deletedAt: null } });
    const sessions = await this.db.session.findMany({ where: { identityId, deletedAt: null }, include: { identity: true, segments: true }, orderBy: { startedAt: "desc" }, skip: page * pageSize, take: pageSize });
    if (!sessions.length) throw new Error("No sessions found");
    const identity = sessions[0]!.identity;
    const owner = identity.discordUserId ? `**${identity.robloxUsername}** · <@${identity.discordUserId}>` : `**${identity.robloxUsername}**`;
    const description = sessions.map((session) => {
      const end = session.endedAt ?? new Date();
      const totals = totalsForPeriod(session.segments, session.startedAt, end, end);
      const state = session.state === "ENDED" ? "Completed" : session.state === "ACTIVE" ? "Active now" : session.state === "INACTIVE" ? "Inactive now" : "Waiting for reconnect";
      const timing = session.endedAt
        ? `Started <t:${Math.floor(session.startedAt.getTime()/1000)}:f> and ended <t:${Math.floor(session.endedAt.getTime()/1000)}:R>`
        : `Started <t:${Math.floor(session.startedAt.getTime()/1000)}:R>`;
      return `**${state}**\n${timing}\n${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active · ${friendlyDuration(totals.inactiveMs)} inactive\nSession ID: \`${session.id}\``;
    }).join("\n\n");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`historypage:${identityId}:${page-1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`historypage:${identityId}:${page+1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled((page+1)*pageSize >= count),
    );
    const response = {
      embeds: [new EmbedBuilder().setTitle("Session history").setDescription(`${owner}\n\n${description}`).setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(count/pageSize))}` })],
      components: [row],
    };
    if (interaction.isButton()) await interaction.update(response);
    else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
  }

  private presetDates(period: string): { startDate: string; endDate: string } {
    const now = DateTime.now().setZone(this.config.REPORT_TIMEZONE);
    let start = now.startOf("month");
    let end = now.endOf("month");
    if (period === "week") { start = now.startOf("week"); end = now.endOf("week"); }
    if (period === "year") { start = now.startOf("year"); end = now.endOf("year"); }
    if (period === "all") { start = DateTime.fromISO("2006-01-01", { zone: this.config.REPORT_TIMEZONE }); end = now.endOf("day"); }
    return { startDate: start.toISODate()!, endDate: end.toISODate()! };
  }

  private async renderLeaderboard(interaction: ChatInputCommandInteraction | ButtonInteraction, startDate: string, endDate: string, minimum: number, page: number): Promise<void> {
    const { start, end } = tallinnDateRange(startDate, endDate, this.config.REPORT_TIMEZONE);
    const identities = await this.db.identity.findMany({ include: { sessions: { where: { deletedAt: null, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] }, include: { segments: true } } } });
    const rows = buildLeaderboard(identities.map((identity) => ({
      identityId: identity.id,
      username: identity.discordUserId ? `${identity.robloxUsername} · <@${identity.discordUserId}>` : identity.robloxUsername,
      segments: identity.sessions.flatMap((session) => session.segments),
    })), start, end, minimum);
    const pageRows = rows.slice(page*10, page*10+10);
    const period = friendlyPeriod(startDate, endDate, this.config.REPORT_TIMEZONE);
    const ranking = pageRows.map((row, index) => {
      const place = page * 10 + index + 1;
      const marker = (["🥇", "🥈", "🥉"] as const)[place - 1] ?? `**${place}.**`;
      return `${marker} **${row.username}**\n> ${friendlyDuration(row.totals.totalMs)} total · ${friendlyDuration(row.totals.activeMs)} active`;
    }).join("\n\n");
    const description = ranking
      ? `Here’s how the team ranks for **${period}**.\n\n${ranking}`
      : `No one has logged any time during **${period}** yet.`;
    const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
    if (pageRows.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("leaderboard-user").setPlaceholder("Choose someone to view their history").addOptions(pageRows.map((row) => ({ label: row.username.split(" · ")[0]!.slice(0,100), value: row.identityId })))));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page-1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page}`).setLabel("Refresh").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page+1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled((page+1)*10 >= rows.length),
    ));
    const response = {
      embeds: [new EmbedBuilder()
        .setTitle("Staff leaderboard")
        .setDescription(description)
        .setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(rows.length/10))} · Total time includes inactive and reconnecting time` })],
      components,
    };
    if (interaction.isButton()) await interaction.update(response);
    else await interaction.reply(response);
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === "leaderboard-user") await this.replyHistory(interaction as unknown as ButtonInteraction, interaction.values[0]!, 0);
  }
}
