import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder,
  ChannelSelectMenuBuilder, ChannelType, GuildMember, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder,
  SlashCommandBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags, type ButtonInteraction, type Client, type Interaction,
  type ChannelSelectMenuInteraction, type ModalSubmitInteraction, type RoleSelectMenuInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { Config } from "../config.js";
import type { prisma as database } from "../db.js";
import { assertDurationInvariant, formatDuration, totalsForPeriod } from "../domain/accounting.js";
import { buildLeaderboard, tallinnDateRange } from "../domain/reporting.js";
import type { BloxlinkService } from "../services/bloxlink.js";
import type { RuntimeSettingsService } from "../services/runtime-settings.js";
import type { DiscordPublisher } from "./publisher.js";

type Db = typeof database;

export const PUBLIC_COMPONENT_LIFETIME_MS = 15 * 60_000;

type PublicComponentRegistration = {
  userId: string;
  onExpire: () => Promise<void>;
  timeout: NodeJS.Timeout;
};

export class PublicComponentTracker {
  private readonly registrations = new Map<string, PublicComponentRegistration>();

  constructor(private readonly lifetimeMs = PUBLIC_COMPONENT_LIFETIME_MS) {}

  track(messageId: string, userId: string, onExpire: () => Promise<void>): void {
    const previous = this.registrations.get(messageId);
    if (previous) clearTimeout(previous.timeout);

    const registration: PublicComponentRegistration = {
      userId,
      onExpire,
      timeout: setTimeout(() => {
        if (this.registrations.get(messageId) !== registration) return;
        this.registrations.delete(messageId);
        void onExpire().catch((error: unknown) => console.error("Failed to disable expired public controls", { error, messageId }));
      }, this.lifetimeMs),
    };
    registration.timeout.unref();
    this.registrations.set(messageId, registration);
  }

  access(messageId: string, userId: string): "allowed" | "not-owner" | "expired" {
    const registration = this.registrations.get(messageId);
    if (!registration) return "expired";
    if (registration.userId !== userId) return "not-owner";
    this.track(messageId, userId, registration.onExpire);
    return "allowed";
  }
}

export const commandData = [
  new SlashCommandBuilder().setName("session").setDescription("Manage staff sessions")
    .addSubcommand((s) => s.setName("active").setDescription("🟢 Show a live session")
      .addUserOption((o) => o.setName("user").setDescription("Discord user (defaults to you; other members need Admin)").setRequired(false)))
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
  new SlashCommandBuilder().setName("config").setDescription("Open the session tracking configuration panel"),
].map((command) => command.toJSON());

export const PermissionLevel = {
  EVERYONE: 1,
  STAFF: 2,
  ADMIN: 3,
  MANAGER: 4,
} as const;

class UserFacingError extends Error {}

function userError(message: string): never {
  throw new UserFacingError(message);
}

export function requiredPermission(commandName: string, subcommand?: string): number {
  if (commandName === "leaderboard") return PermissionLevel.EVERYONE;
  if (commandName === "config") return PermissionLevel.MANAGER;
  if (commandName === "session" && ["view", "active"].includes(subcommand ?? "")) return PermissionLevel.STAFF;
  if (commandName === "session" && ["add", "manage"].includes(subcommand ?? "")) return PermissionLevel.ADMIN;
  return PermissionLevel.MANAGER;
}

export function parsePermissionRoleChoice(customId: string): { roleId: string; choice: string } | null {
  const prefix = "config-role-level:";
  if (!customId.startsWith(prefix)) return null;
  const [roleId, choice] = customId.slice(prefix.length).split(":");
  return roleId && choice ? { roleId, choice } : null;
}

function input(id: string, label: string, value = "", required = true): ActionRowBuilder<TextInputBuilder> {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required);
  if (value) field.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}

export function parseSessionDateTime(value: string, timezone: string): Date {
  const input = value.trim();
  const iso = DateTime.fromISO(input, { setZone: true });
  if (iso.isValid) return iso.toJSDate();

  for (const format of ["d/M/yyyy H:mm", "d.M.yyyy H:mm", "d-M-yyyy H:mm", "yyyy-MM-dd H:mm"]) {
    const local = DateTime.fromFormat(input, format, { zone: timezone });
    if (local.isValid) return local.toJSDate();
  }
  throw new Error("Invalid date and time. Use 11/07/2026 14:30 (your reporting time zone).");
}

export function formatSessionDateTime(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("dd/LL/yyyy HH:mm");
}

function parseDuration(value: string): number {
  const clock = value.trim().match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (clock) return ((Number(clock[1]) * 3600) + (Number(clock[2]) * 60) + Number(clock[3] ?? 0)) * 1000;
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

export function friendlyPeriod(startDate: string, endDate: string, timezone: string): string {
  const start = DateTime.fromISO(startDate, { zone: timezone });
  const end = DateTime.fromISO(endDate, { zone: timezone });
  const coversFullMonth = start.hasSame(end, "month") && start.day === 1 && end.day === end.daysInMonth;
  if (coversFullMonth) return start.toFormat("LLLL yyyy");
  if (start.year === end.year) return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d, yyyy")}`;
  return `${start.toFormat("LLL d, yyyy")} – ${end.toFormat("LLL d, yyyy")}`;
}

export class CommandHandler {
  private readonly publicComponents = new PublicComponentTracker();

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly publisher: DiscordPublisher,
    private readonly bloxlink: BloxlinkService,
    private readonly settings: RuntimeSettingsService,
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch(async (error: unknown) => {
      const message = error instanceof UserFacingError ? error.message : "The request could not be completed. Please try again later.";
      if (!(error instanceof UserFacingError)) console.error("Discord interaction failed", {
        error,
        command: interaction.isCommand() ? interaction.commandName : undefined,
        customId: interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId : undefined,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      if (interaction.isRepliable()) {
        // Delivering the error can itself fail (e.g. the interaction already
        // expired with a 10062). Swallow that so it never crashes the process.
        try {
          if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `Error: ${message}` });
          else if (interaction.replied) await interaction.followUp({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
          else await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral });
        } catch (replyError) {
          console.error("Failed to deliver interaction error message", { replyError, userId: interaction.user.id });
        }
      }
    }));
  }

  private memberRoles(interaction: Interaction): string[] {
    if (!interaction.member) return [];
    return interaction.member instanceof GuildMember ? [...interaction.member.roles.cache.keys()] : interaction.member.roles;
  }

  private hasDiscordAdministrator(interaction: Interaction): boolean {
    if (!interaction.member) return false;
    if (interaction.member instanceof GuildMember) return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    return (BigInt(interaction.member.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
  }

  private async permissionLevel(interaction: Interaction): Promise<number> {
    if (this.hasDiscordAdministrator(interaction)) {
      return PermissionLevel.MANAGER;
    }
    const roleIds = this.memberRoles(interaction);
    const configured = roleIds.length
      ? await this.db.permissionRole.findMany({ where: { roleId: { in: roleIds } }, select: { level: true } })
      : [];
    return Math.max(PermissionLevel.EVERYONE, ...configured.map(({ level }) => level));
  }

  private async hasPermission(interaction: Interaction, required: number): Promise<boolean> {
    return (await this.permissionLevel(interaction)) >= required;
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (this.config.DISCORD_GUILD_ID && interaction.guildId !== this.config.DISCORD_GUILD_ID) {
      userError("This command is not available in this server");
    }
    if (interaction.isChatInputCommand()) await this.handleCommand(interaction);
    else if (interaction.isModalSubmit()) await this.handleModal(interaction);
    else if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isChannelSelectMenu()) await this.handleChannelSelect(interaction);
    else if (interaction.isRoleSelectMenu()) await this.handleRoleSelect(interaction);
    else if (interaction.isStringSelectMenu()) await this.handleSelect(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "leaderboard") {
      await interaction.deferReply();
      const period = interaction.options.getString("period") ?? "month";
      const { startDate, endDate } = this.presetDates(period);
      await this.renderLeaderboard(interaction, startDate, endDate, 0, 0); return;
    }
    if (interaction.commandName === "config") {
      if (!await this.hasPermission(interaction, PermissionLevel.MANAGER)) userError("Manager role required");
      await this.handleConfig(interaction); return;
    }
    const action = interaction.options.getSubcommand();
    const required = requiredPermission(interaction.commandName, action);
    if (!await this.hasPermission(interaction, required)) {
      const label = required === PermissionLevel.MANAGER ? "Manager" : required === PermissionLevel.ADMIN ? "Admin" : "Staff";
      userError(`${label} role required`);
    }
    if (action === "add") await this.showAdd(interaction);
    if (action === "manage") await this.showManage(interaction);
    if (action === "view") await this.showView(interaction);
    if (action === "active") await this.showActive(interaction);
  }

  private async handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ ...await this.configPanel(), flags: MessageFlags.Ephemeral });
  }

  private async configPanel() {
    const settings = await this.settings.get();
    const permissions = await this.db.permissionRole.findMany({ orderBy: { level: "desc" } });
    const roles = permissions.length
      ? permissions.map(({ roleId, level }) => `<@&${roleId}> — ${this.permissionLabel(level)}`).join("\n")
      : "No role permissions configured.";
    const embed = new EmbedBuilder()
      .setTitle("⚙️ Session tracking configuration")
      .setDescription("Use the controls below to change settings. This panel is only visible to you.")
      .addFields(
        { name: "Tracking", value: settings.trackingEnabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
        { name: "Logs channel", value: settings.logsChannelId ? `<#${settings.logsChannelId}>` : "Not configured", inline: true },
        { name: "Role permissions", value: roles },
      );
    const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("config-logs").setPlaceholder("Choose the session logs channel").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    const roleRow = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder().setCustomId("config-role").setPlaceholder("Choose a role to configure"),
    );
    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`config-tracking:${settings.trackingEnabled ? "off" : "on"}`).setStyle(settings.trackingEnabled ? ButtonStyle.Danger : ButtonStyle.Success).setLabel(settings.trackingEnabled ? "Disable tracking" : "Enable tracking"),
      new ButtonBuilder().setCustomId("cancel").setStyle(ButtonStyle.Secondary).setLabel("Close").setEmoji("✖️"),
    );
    return { embeds: [embed], components: [channelRow, roleRow, buttonRow] };
  }

  private permissionLabel(level: number): string {
    return level === PermissionLevel.MANAGER ? "Manager" : level === PermissionLevel.ADMIN ? "Admin" : "Staff";
  }

  private async showAdd(interaction: ChatInputCommandInteraction): Promise<void> {
    const user = interaction.options.getUser("user", true);
    const mapped = await this.bloxlink.robloxForDiscord(user.id);
    if (!mapped) userError("That Discord user has no Bloxlink mapping");
    const modal = new ModalBuilder().setCustomId(`add:${user.id}`).setTitle("➕ Add completed session").addComponents(
      input("start", "Start (example: 11/07/2026 14:30)"), input("end", "End (example: 11/07/2026 16:45)"),
      input("active", "Active time (example: 2h 15m)"), input("inactive", "Inactive time (example: 10m)"),
      input("note", "Reason for adding this session"),
    );
    await interaction.showModal(modal);
  }

  private async showManage(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("sessionid", true);
    const session = await this.db.session.findUnique({ where: { id }, include: { identity: true } });
    if (!session || session.deletedAt) userError("Session not found");
    if (session.state !== "ENDED") userError("Live sessions cannot be managed");
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser("user", true);
    let identity = await this.db.identity.findFirst({ where: { discordUserId: user.id } });
    if (!identity) {
      const mapped = await this.bloxlink.robloxForDiscord(user.id);
      if (mapped) identity = await this.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
    }
    if (!identity) userError("Identity not found");
    await this.replyHistory(interaction, identity.id, 0, "reply");
  }

  private async showActive(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user") ?? interaction.user;
    const isSelf = target.id === interaction.user.id;
    if (!isSelf && !await this.hasPermission(interaction, PermissionLevel.ADMIN)) {
      userError("Admin role required to view another member's active session");
    }
    let identity = await this.db.identity.findFirst({ where: { discordUserId: target.id } });
    if (!identity) {
      // No local record yet — that only exists once we've tracked a session for
      // them. Resolve via Bloxlink so we can tell "never verified" apart from
      // "verified but never tracked / not in game right now".
      const mapped = await this.bloxlink.robloxForDiscord(target.id);
      if (!mapped) userError(isSelf ? "You haven't linked a Roblox account with Bloxlink yet" : "That member hasn't linked a Roblox account with Bloxlink yet");
      identity = await this.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
    }
    if (!identity) userError(isSelf ? "You have no active session right now" : "That member has no active session right now");
    const session = await this.db.session.findFirst({
      where: { identityId: identity.id, state: { not: "ENDED" }, deletedAt: null },
      include: { segments: true },
      orderBy: { startedAt: "desc" },
    });
    if (!session) userError(isSelf ? "You have no active session right now" : `${identity.robloxUsername} has no active session right now`);
    const now = new Date();
    const totals = totalsForPeriod(session.segments, session.startedAt, now, now);
    const state = session.state === "ACTIVE" ? "Active now" : session.state === "INACTIVE" ? "Inactive now" : "Waiting for reconnect";
    const icon = session.state === "ACTIVE" ? "🟢" : session.state === "INACTIVE" ? "🟡" : "🔵";
    const owner = identity.discordUserId ? `**${identity.robloxUsername}** · <@${identity.discordUserId}>` : `**${identity.robloxUsername}**`;
    const embed = new EmbedBuilder()
      .setTitle(`${icon} ${state}`)
      .setDescription(`👤 ${owner}`)
      .addFields(
        { name: "🗓️ Started", value: `<t:${Math.floor(session.startedAt.getTime() / 1000)}:R>`, inline: true },
        { name: "🖥️ Server", value: `\`${session.jobId}\``, inline: true },
        { name: "⏱️ Time so far", value: `${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active · ${friendlyDuration(totals.inactiveMs)} inactive`, inline: false },
        { name: "🆔 Session ID", value: `\`${session.id}\``, inline: false },
      );
    await interaction.editReply({ embeds: [embed] });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith("add:")) await this.addSession(interaction);
    else if (interaction.customId.startsWith("editended:")) await this.editEnded(interaction);
  }

  private async addSession(interaction: ModalSubmitInteraction): Promise<void> {
    if (!await this.hasPermission(interaction, PermissionLevel.ADMIN)) userError("Admin role required");
    const start = parseSessionDateTime(interaction.fields.getTextInputValue("start"), this.config.REPORT_TIMEZONE);
    const end = parseSessionDateTime(interaction.fields.getTextInputValue("end"), this.config.REPORT_TIMEZONE);
    const active = parseDuration(interaction.fields.getTextInputValue("active"));
    const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
    assertDurationInvariant(start, end, active, inactive);
    const discordUserId = interaction.customId.slice(4);
    const mapped = await this.bloxlink.robloxForDiscord(discordUserId);
    if (!mapped) userError("That Discord user has no Bloxlink mapping");
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
    if (!await this.hasPermission(interaction, PermissionLevel.ADMIN)) userError("Admin role required");
    const id = interaction.customId.slice("editended:".length);
    const start = parseSessionDateTime(interaction.fields.getTextInputValue("start"), this.config.REPORT_TIMEZONE);
    const end = parseSessionDateTime(interaction.fields.getTextInputValue("end"), this.config.REPORT_TIMEZONE);
    const active = parseDuration(interaction.fields.getTextInputValue("active")); const inactive = parseDuration(interaction.fields.getTextInputValue("inactive"));
    const current = await this.db.session.findUnique({ where: { id } }); if (!current || current.state !== "ENDED" || current.deletedAt) userError("Completed session not found");
    const reconnect = Number(current.reconnectMilliseconds);
    assertDurationInvariant(start, end, active, inactive + reconnect);
    await this.db.$transaction(async (tx) => {
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
    await this.publisher.refresh(id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("✅ Session updated").setDescription("The completed session was updated successfully.").addFields({ name: "🆔 Session ID", value: `\`${id}\`` })],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async showEditEndedModal(interaction: ButtonInteraction, id: string): Promise<void> {
    if (!await this.hasPermission(interaction, PermissionLevel.ADMIN)) userError("Admin role required");
    const session = await this.db.session.findUnique({ where: { id } });
    if (!session || session.deletedAt) userError("Session not found");
    if (session.state !== "ENDED") userError("Live sessions cannot be managed");
    const modal = new ModalBuilder().setCustomId(`editended:${id}`).setTitle("✏️ Edit completed session").addComponents(
      input("start", "Start (example: 11/07/2026 14:30)", formatSessionDateTime(session.startedAt, this.config.REPORT_TIMEZONE)),
      input("end", "End (example: 11/07/2026 16:45)", formatSessionDateTime(session.endedAt!, this.config.REPORT_TIMEZONE)),
      input("active", "Active time (example: 2h 15m)", formatDuration(session.activeMilliseconds)),
      input("inactive", "Inactive time (example: 10m)", formatDuration(session.inactiveMilliseconds)),
      input("note", "Reason for this edit"),
    );
    await interaction.showModal(modal);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === "cancel" || interaction.customId === "historyclose") {
      await interaction.deferUpdate();
      await interaction.deleteReply(interaction.message.id);
      return;
    }
    if (interaction.customId.startsWith("refresh:")) {
      await interaction.deferUpdate();
      await this.publisher.refresh(interaction.customId.slice(8));
      return;
    }
    if (interaction.customId.startsWith("config-tracking:")) {
      if (!await this.hasPermission(interaction, PermissionLevel.MANAGER)) userError("Manager role required");
      await this.settings.setTrackingEnabled(interaction.customId.endsWith(":on"));
      await interaction.update(await this.configPanel());
      return;
    }
    if (interaction.customId.startsWith("config-role-level:")) {
      if (!await this.hasPermission(interaction, PermissionLevel.MANAGER)) userError("Manager role required");
      const selection = parsePermissionRoleChoice(interaction.customId);
      if (!selection) userError("Role or permission level not found");
      const { roleId, choice } = selection;
      if (choice === "remove") {
        await this.db.permissionRole.deleteMany({ where: { roleId } });
        await interaction.update(await this.configPanel());
        return;
      }
      const level = Number(choice);
      if (![PermissionLevel.STAFF, PermissionLevel.ADMIN, PermissionLevel.MANAGER].includes(level as 2 | 3 | 4)) userError("Invalid permission level");
      await this.db.permissionRole.upsert({ where: { roleId }, create: { roleId, level }, update: { level } });
      await interaction.update(await this.configPanel());
      return;
    }
    if (interaction.customId.startsWith("history:")) {
      if (!await this.hasPermission(interaction, PermissionLevel.STAFF)) userError("Staff role required");
      await this.replyHistory(interaction, interaction.customId.slice(8), 0, "reply");
      return;
    }
    if (interaction.customId.startsWith("historypage:")) {
      if (!await this.hasPermission(interaction, PermissionLevel.STAFF)) userError("Staff role required");
      const [, identityId, page] = interaction.customId.split(":");
      await this.replyHistory(interaction, identityId!, Number(page), "update");
      return;
    }
    if (interaction.customId.startsWith("leaderboard:")) {
      await this.requirePublicComponentOwner(interaction);
      const [, startDate, endDate, minimum, page] = interaction.customId.split(":");
      await this.renderLeaderboard(interaction, startDate!, endDate!, Number(minimum), Number(page)); return;
    }
    if (interaction.customId.startsWith("editended:")) {
      await this.showEditEndedModal(interaction, interaction.customId.slice("editended:".length)); return;
    }
    if (interaction.customId.startsWith("remove:")) {
      if (!await this.hasPermission(interaction, PermissionLevel.ADMIN)) userError("Admin role required"); const id = interaction.customId.slice(7);
      const current = await this.db.session.findUnique({ where: { id } }); if (!current || current.deletedAt) userError("Session not found");
      if (current.state !== "ENDED") userError("Live sessions cannot be managed");
      const now = new Date();
      await this.db.$transaction(async (tx) => {
        await tx.session.update({ where: { id }, data: { deletedAt: now } });
        await tx.auditEntry.create({ data: {
          sessionId: id, actorType: "DISCORD", actorId: interaction.user.id, action: "SESSION_REMOVE",
          before: { deletedAt: null }, after: { deletedAt: now },
        } });
      });
      await this.publisher.refresh(id, true);
      await interaction.update({ content: `Session ${id} removed from statistics.`, components: [] });
    }
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config-logs") return;
    if (!await this.hasPermission(interaction, PermissionLevel.MANAGER)) userError("Manager role required");
    const channel = interaction.channels.first();
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) userError("Choose a text channel for session logs");
    await this.settings.setLogsChannel(channel.id);
    await interaction.update(await this.configPanel());
  }

  private async handleRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config-role") return;
    if (!await this.hasPermission(interaction, PermissionLevel.MANAGER)) userError("Manager role required");
    const roleId = interaction.values[0];
    if (!roleId) userError("Choose a role");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`config-role-level:${roleId}:${PermissionLevel.STAFF}`).setLabel("Staff").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config-role-level:${roleId}:${PermissionLevel.ADMIN}`).setLabel("Admin").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`config-role-level:${roleId}:${PermissionLevel.MANAGER}`).setLabel("Manager").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`config-role-level:${roleId}:remove`).setLabel("Remove").setStyle(ButtonStyle.Danger),
    );
    await interaction.update({ content: `Choose the permission level for <@&${roleId}>:`, embeds: [], components: [row] });
  }

  private async replyHistory(
    interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
    identityId: string,
    page: number,
    responseMode: "reply" | "update",
  ): Promise<void> {
    const pageSize = 10; const count = await this.db.session.count({ where: { identityId, deletedAt: null } });
    const sessions = await this.db.session.findMany({ where: { identityId, deletedAt: null }, include: { identity: true, segments: true }, orderBy: { startedAt: "desc" }, skip: page * pageSize, take: pageSize });
    if (!sessions.length) userError("No sessions found");
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
      new ButtonBuilder().setCustomId("historyclose").setLabel("Close").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
    );
    const response = {
      embeds: [new EmbedBuilder().setTitle("📚 Session history").setDescription(`👤 ${owner}\n\n${description}`).setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(count/pageSize))}` })],
      components: [row],
    };
    if (responseMode === "update" && interaction.isButton()) await interaction.update(response);
    else if (interaction.deferred || interaction.replied) await interaction.editReply(response);
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
    const components = this.leaderboardComponents(pageRows, rows.length, startDate, endDate, minimum, page);
    const expiredComponents = this.leaderboardComponents(pageRows, rows.length, startDate, endDate, minimum, page, true);
    const response = {
      embeds: [new EmbedBuilder()
        .setTitle("🏆 Staff leaderboard")
        .setDescription(description)
        .setFooter({ text: `Page ${page+1} of ${Math.max(1, Math.ceil(rows.length/10))} · Total time includes inactive time; reconnecting gaps are excluded` })],
      components,
    };
    if (interaction.isButton()) {
      await interaction.update(response);
      this.publicComponents.track(interaction.message.id, interaction.user.id, async () => {
        await interaction.message.edit({ components: expiredComponents });
      });
    } else {
      const message = interaction.deferred || interaction.replied
        ? await interaction.editReply(response)
        : await interaction.reply(response);
      this.publicComponents.track(message.id, interaction.user.id, async () => {
        await message.edit({ components: expiredComponents });
      });
    }
  }

  private leaderboardComponents(
    pageRows: Array<{ identityId: string; username: string }>,
    rowCount: number,
    startDate: string,
    endDate: string,
    minimum: number,
    page: number,
    disabled = false,
  ): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
    const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
    if (pageRows.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("leaderboard-user")
        .setPlaceholder("👤 View a user's session history")
        .addOptions(pageRows.map((row) => ({ label: row.username.split(" · ")[0]!.slice(0, 100), value: row.identityId })))
        .setDisabled(disabled),
    ));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page-1}`).setLabel("Previous").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`leaderboard:${startDate}:${endDate}:${minimum}:${page+1}`).setLabel("Next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(disabled || (page+1)*10 >= rowCount),
    ));
    return components;
  }

  private async requirePublicComponentOwner(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const access = this.publicComponents.access(interaction.message.id, interaction.user.id);
    if (access === "not-owner") userError("Only the person who ran this command can use these controls");
    if (access === "expired") {
      await interaction.message.edit({ components: [] }).catch((error: unknown) => {
        console.error("Failed to remove expired public controls", { error, messageId: interaction.message.id });
      });
      userError("These controls have expired. Run the command again");
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === "leaderboard-user") {
      await this.requirePublicComponentOwner(interaction);
      if (!await this.hasPermission(interaction, PermissionLevel.STAFF)) userError("Staff role required");
      await this.replyHistory(interaction, interaction.values[0]!, 0, "reply");
    }
  }
}
