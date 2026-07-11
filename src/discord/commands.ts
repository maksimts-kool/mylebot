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
    .addSubcommand((s) => s.setName("view").setDescription("📚 View a user's session history")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true)))
    .addSubcommand((s) => s.setName("manage").setDescription("🛠️ Manage a completed session")
      .addStringOption((o) => o.setName("sessionid").setDescription("Completed session ID").setRequired(true)))
    .addSubcommand((s) => s.setName("add").setDescription("➕ Add a completed session")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))),
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
    if (["add", "manage"].includes(action) && !this.isAdmin(interaction)) throw new Error("Administrator role required");
    if (action === "view" && !await this.canReport(interaction)) throw new Error("You do not have permission to view history");
    if (action === "add") await this.showAdd(interaction);
    if (action === "manage") await this.showManage(interaction);
    if (action === "view") await this.showView(interaction);
  }

  private async showAdd(interaction: ChatInputCommandInteraction): Promise<void> {
    const user = interaction.options.getUser("user", true);
    const mapped = await this.bloxlink.robloxForDiscord(user.id);
    if (!mapped) throw new Error("That Discord user has no Bloxlink mapping");
    const modal = new ModalBuilder().setCustomId(`add:${user.id}`).setTitle("➕ Add completed session").addComponents(
      input("start", "Start (ISO date and time)"), input("end", "End (ISO date and time)"),
      input("active", "Active time (example: 2h 15m)"), input("inactive", "Inactive time (example: 10m)"),
      input("note", "Reason for adding this session"),
    );
    await interaction.showModal(modal);
  }

  private async showManage(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("sessionid", true);
    const session = await this.db.session.findUnique({ where: { id }, include: { identity: true } });
    if (!session || session.deletedAt) throw new Error("Session not found");
    if (session.state !== "ENDED") throw new Error("Live sessions cannot be managed");
    const totals = Number(session.activeMilliseconds) + Number(session.inactiveMilliseconds);
    const embed = new EmbedBuilder().setTitle("🛠️ Manage completed session").setDescription(`Manage the completed session for **${session.identity.robloxUsername}**.`).addFields(
      { name: "👤 Staff", value: session.identity.discordUserId ? `<@${session.identity.discordUserId}>` : "No linked Discord user", inline: true },
      { name: "🗓️ When", value: `<t:${Math.floor(session.startedAt.getTime() / 1000)}:f> to <t:${Math.floor(session.endedAt!.getTime() / 1000)}:f>`, inline: false },
      { name: "⏱️ Recorded time", value: `${friendlyDuration(totals)} total · ${friendlyDuration(Number(session.activeMilliseconds))} active`, inline: false },
      { name: "🆔 Session ID", value: `\`${session.id}\`` },
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`editended:${id}`).setStyle(ButtonStyle.Primary).setLabel("Edit").setEmoji("✏️"),
      new ButtonBuilder().setCustomId(`remove:${id}`).setStyle(ButtonStyle.Danger).setLabel("Remove").setEmoji("🗑️"),
      new ButtonBuilder().setCustomId("cancel").setStyle(ButtonStyle.Secondary).setLabel("Close").setEmoji("✖️"),
    );
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  }

  private async showView(interaction: ChatInputCommandInteraction): Promise<void> {
    const user = interaction.options.getUser("user", true);
    let identity = await this.db.identity.findFirst({ where: { discordUserId: user.id } });
    if (!identity) {
      const mapped = await this.bloxlink.robloxForDiscord(user.id);
      if (mapped) identity = await this.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
    }
    if (!identity) throw new Error("Identity not found");
    await this.replyHistory(interaction, identity.id, 0);
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith("add:")) await this.addSession(interaction);
    else if (interaction.customId.startsWith("editended:")) await this.editEnded(interaction);
  }

  private async addSession(interaction: ModalSubmitInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) throw new Error("Administrator role required");
    const start = parseInstant(interaction.fields.getTextInputValue("start"));
    const end = parseInstant(interaction.fields.getTextInputValue("end"));
    const active = parseDuration(interaction.fields.getTextInputValue("active"));
    const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
    assertDurationInvariant(start, end, active, inactive);
    const discordUserId = interaction.customId.slice(4);
    const mapped = await this.bloxlink.robloxForDiscord(discordUserId);
    if (!mapped) throw new Error("That Discord user has no Bloxlink mapping");
    const username = mapped.username;
    const identity = await this.db.identity.upsert({
      where: { robloxUserId: mapped.userId },
      create: { robloxUserId: mapped.userId, robloxUsername: username, discordUserId },
      update: { robloxUsername: username, discordUserId },
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
      await tx.auditEntry.create({ data: { sessionId: created.id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_ADD", note: interaction.fields.getTextInputValue("note") } });
      return created;
    });
    await this.publisher.refresh(session.id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("✅ Session added").setDescription(`A completed session was added for **${username}**.`).addFields(
        { name: "🗓️ When", value: `<t:${Math.floor(start.getTime() / 1000)}:f> to <t:${Math.floor(end.getTime() / 1000)}:t>` },
        { name: "⏱️ Time recorded", value: `${friendlyDuration(active)} active · ${friendlyDuration(inactive)} inactive` },
        { name: "🆔 Session ID", value: `\`${session.id}\`` },
      )],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async editEnded(interaction: ModalSubmitInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) throw new Error("Administrator role required");
    const id = interaction.customId.slice("editended:".length);
    const start = parseInstant(interaction.fields.getTextInputValue("start")); const end = parseInstant(interaction.fields.getTextInputValue("end"));
    const active = parseDuration(interaction.fields.getTextInputValue("active")); const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
    const current = await this.db.session.findUnique({ where: { id } }); if (!current || current.state !== "ENDED" || current.deletedAt) throw new Error("Completed session not found");
    const reconnect = Number(current.reconnectMilliseconds);
    assertDurationInvariant(start, end, active, inactive + reconnect);
    await this.db.$transaction(async (tx) => {
      await tx.timeSegment.deleteMany({ where: { sessionId: id } }); const activeEnd = new Date(start.getTime() + active);
      if (active) await tx.timeSegment.create({ data: { sessionId: id, state: "ACTIVE", startedAt: start, endedAt: activeEnd } });
      const inactiveEnd = new Date(activeEnd.getTime() + inactive);
      if (inactive) await tx.timeSegment.create({ data: { sessionId: id, state: "INACTIVE", startedAt: activeEnd, endedAt: inactiveEnd } });
      if (reconnect) await tx.timeSegment.create({ data: { sessionId: id, state: "RECONNECTING", startedAt: inactiveEnd, endedAt: end } });
      await tx.session.update({ where: { id }, data: { startedAt: start, endedAt: end, lastEventAt: end, lastStateAt: end, activeMilliseconds: BigInt(active), inactiveMilliseconds: BigInt(inactive), reconnectMilliseconds: BigInt(reconnect) } });
      await tx.auditEntry.create({ data: { sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_EDIT_ENDED", note: interaction.fields.getTextInputValue("note") } });
    });
    await this.publisher.refresh(id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("✅ Session updated").setDescription("The completed session was updated successfully.").addFields({ name: "🆔 Session ID", value: `\`${id}\`` })],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async showEditEndedModal(interaction: ButtonInteraction, id: string): Promise<void> {
    if (!this.isAdmin(interaction)) throw new Error("Administrator role required");
    const session = await this.db.session.findUnique({ where: { id } });
    if (!session || session.deletedAt) throw new Error("Session not found");
    if (session.state !== "ENDED") throw new Error("Live sessions cannot be managed");
    const modal = new ModalBuilder().setCustomId(`editended:${id}`).setTitle("✏️ Edit completed session").addComponents(
      input("start", "Start (ISO date and time)", session.startedAt.toISOString()),
      input("end", "End (ISO date and time)", session.endedAt!.toISOString()),
      input("active", "Active time (example: 2h 15m)", formatDuration(session.activeMilliseconds)),
      input("inactive", "Inactive time (example: 10m)", formatDuration(session.inactiveMilliseconds)),
      input("note", "Reason for this edit"),
    );
    await interaction.showModal(modal);
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
    if (interaction.customId.startsWith("editended:")) {
      await this.showEditEndedModal(interaction, interaction.customId.slice("editended:".length)); return;
    }
    if (interaction.customId.startsWith("remove:")) {
      if (!this.isAdmin(interaction)) throw new Error("Administrator role required"); const id = interaction.customId.slice(7);
      const current = await this.db.session.findUnique({ where: { id } }); if (!current || current.deletedAt) throw new Error("Session not found");
      if (current.state !== "ENDED") throw new Error("Live sessions cannot be managed");
      const now = new Date();
      await this.db.$transaction(async (tx) => {
        await tx.session.update({ where: { id }, data: { deletedAt: now } });
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
      const icon = session.state === "ENDED" ? "✅" : session.state === "ACTIVE" ? "🟢" : session.state === "INACTIVE" ? "🟡" : "🔵";
      return `${icon} **${state}**\n🗓️ ${timing}\n⏱️ ${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active · ${friendlyDuration(totals.inactiveMs)} inactive\n🆔 Session ID: \`${session.id}\``;
    }).join("\n\n");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`historypage:${identityId}:${page-1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`historypage:${identityId}:${page+1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled((page+1)*pageSize >= count),
    );
    const response = {
      embeds: [new EmbedBuilder().setTitle("📚 Session history").setDescription(`👤 ${owner}\n\n${description}`).setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(count/pageSize))}` })],
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
      return `${marker} **${row.username}**\n⏱️ ${friendlyDuration(row.totals.totalMs)} total · ${friendlyDuration(row.totals.activeMs)} active`;
    }).join("\n\n");
    const description = ranking
      ? `🗓️ **Period:** ${period}\n\n${ranking}`
      : `🗓️ **Period:** ${period}\n\n👥 No one has logged any time yet.`;
    const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
    if (pageRows.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("leaderboard-user").setPlaceholder("👤 View a user's session history").addOptions(pageRows.map((row) => ({ label: row.username.split(" · ")[0]!.slice(0,100), value: row.identityId })))));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page-1}`).setLabel("Previous").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page+1}`).setLabel("Next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled((page+1)*10 >= rows.length),
    ));
    const response = {
      embeds: [new EmbedBuilder()
        .setTitle("🏆 Staff leaderboard")
        .setDescription(description)
        .setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(rows.length/10))} · Total time includes inactive time; reconnecting gaps are excluded` })],
      components,
    };
    if (interaction.isButton()) await interaction.update(response);
    else await interaction.reply(response);
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === "leaderboard-user") await this.replyHistory(interaction as unknown as ButtonInteraction, interaction.values[0]!, 0);
  }
}
