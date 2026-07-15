import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags,
  ChannelSelectMenuBuilder, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction,
  type Client, type Interaction, type Message, type ModalSubmitInteraction,
  type RoleSelectMenuInteraction, type StringSelectMenuInteraction, type TextChannel,
} from "discord.js";
import { DemoError } from "../domain/errors.js";
import type { AnswerRecord } from "../domain/questions.js";
import { passed } from "../domain/questions.js";
import { PermissionLevel, RANKS, RANK_CODES, isRankCode, type RankCode } from "../domain/ranks.js";
import { parseChoiceOptions, type StaffService } from "../services/staff-service.js";
import type { Application, Store } from "../store/store.js";
import { botLevel, hasBotLevel, resolveActor } from "./permissions.js";

type Payload = { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder>[] };

export class StaffingBot {
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly service: StaffService,
  ) {}

  register(): void {
    this.client.on("interactionCreate", (interaction) => void this.handle(interaction).catch((error: unknown) => this.reportError(interaction, error)));
    this.client.on("messageCreate", (message) => void this.onMessage(message).catch((error: unknown) => console.error("Demo messageCreate failed", error)));
  }

  private async reportError(interaction: Interaction, error: unknown): Promise<void> {
    const message = error instanceof DemoError ? error.message : "Something went wrong. Please try again.";
    if (!(error instanceof DemoError)) console.error("Demo interaction failed", error);
    if (!interaction.isRepliable()) return;
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `⚠️ ${message}` });
      else if (interaction.replied) await interaction.followUp({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral });
    } catch (deliveryError) {
      console.error("Demo error delivery failed", deliveryError);
    }
  }

  // ------------------------------------------------------------------ routing

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) await this.handleCommand(interaction);
    else if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await this.handleStringSelect(interaction);
    else if (interaction.isChannelSelectMenu()) await this.handleChannelSelect(interaction);
    else if (interaction.isRoleSelectMenu()) await this.handleRoleSelect(interaction);
    else if (interaction.isModalSubmit()) await this.handleModal(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "apply") return this.startApply(interaction);
    if (interaction.commandName !== "staff") return;
    const sub = interaction.options.getSubcommand();
    if (sub === "view") return this.staffView(interaction);
    if (sub === "roster") return this.staffRoster(interaction);
    if (sub === "assign") return this.assignRank(interaction);
    if (sub === "promote") return this.setRank(interaction, "promote");
    if (sub === "demote") return this.setRank(interaction, "demote");
    if (sub === "config") return this.openConfig(interaction);
    if (sub === "questions") return this.openQuestions(interaction);
  }

  // ------------------------------------------------------------------ apply flow

  private async startApply(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const track = interaction.options.getString("track", true);
    if (track !== "SURFER" && track !== "ENGINEER") throw new DemoError("Unknown track.");
    if (!interaction.guildId) throw new DemoError("Applications can only be started in a server.");

    const prep = await this.service.prepareApplication(interaction.user.id, track);
    const settings = this.store.getSettings();
    if (!settings.applicationsChannelId) throw new DemoError("No applications channel is set. A manager must run /staff config first.");
    const channel = await this.fetchTextChannel(settings.applicationsChannelId);
    if (!channel) throw new DemoError("The configured applications channel is missing or is not a text channel.");

    const thread = await channel.threads.create({
      name: `application-${prep.identity.username}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: "Lift staff application",
    });
    await thread.members.add(interaction.user.id);
    const application = await this.service.createApplication({ discordUserId: interaction.user.id, identity: prep.identity, track, questions: prep.questions, threadId: thread.id });
    await thread.send({ content: `👋 Welcome <@${interaction.user.id}>! This is your **${RANKS[application.targetRank].label}** application. Answer each question below.` });
    await this.postCurrentQuestion(application);
    await interaction.editReply({ content: `📝 Your application thread is ready: <#${thread.id}>` });
  }

  private async postCurrentQuestion(application: Application): Promise<void> {
    if (!application.threadId) return;
    const thread = await this.fetchThread(application.threadId);
    if (!thread) return;
    const answer = application.answers[application.currentIndex];
    if (!answer) return;
    const index = application.currentIndex;
    const total = application.answers.length;
    if (answer.kind === "TEXT") {
      await thread.send({ embeds: [this.questionEmbed(answer, index, total, "✍️ Type your answer as a message in this thread.")] });
      return;
    }
    await thread.send({ embeds: [this.questionEmbed(answer, index, total, "Tap the control you would use.")], components: this.choiceRows(application.id, answer) });
  }

  private questionEmbed(answer: AnswerRecord, index: number, total: number, hint: string | null): EmbedBuilder {
    const embed = new EmbedBuilder().setTitle(`Question ${index + 1} of ${total}`).setDescription(answer.prompt);
    if (answer.imageUrl) embed.setImage(answer.imageUrl);
    if (hint) embed.setFooter({ text: hint });
    return embed;
  }

  private choiceRows(applicationId: string, answer: AnswerRecord): ActionRowBuilder<ButtonBuilder>[] {
    const options = answer.options ?? [];
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < options.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const [offset, option] of options.slice(i, i + 5).entries()) {
        const optionIndex = i + offset;
        row.addComponents(new ButtonBuilder()
          .setCustomId(`apply-answer:${applicationId}:${answer.questionId}:${optionIndex}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel(option.label.slice(0, 80))
          .setEmoji(option.emoji));
      }
      rows.push(row);
    }
    return rows;
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.channel.isThread()) return;
    const application = this.store.getApplicationByThread(message.channel.id);
    if (!application || application.state !== "IN_PROGRESS" || message.author.id !== application.discordUserId) return;
    const answer = this.service.currentAnswer(application);
    if (!answer || answer.kind !== "TEXT") return; // a CHOICE is pending: ignore stray text
    try {
      const result = await this.service.submitTextAnswer(application.id, message.content);
      await message.react("✅").catch(() => undefined);
      await this.afterAnswer(application.id, result.status);
    } catch (error) {
      const text = error instanceof DemoError ? error.message : "Could not record that answer.";
      await message.channel.send(`⚠️ ${text}`);
    }
  }

  private async handleAnswerButton(interaction: ButtonInteraction): Promise<void> {
    const [, applicationId, questionId, indexRaw] = interaction.customId.split(":");
    if (!applicationId || !questionId) return;
    const application = this.store.getApplication(applicationId);
    if (!application) throw new DemoError("Application not found.");
    if (interaction.user.id !== application.discordUserId) {
      await interaction.reply({ content: "Only the applicant can answer this.", flags: MessageFlags.Ephemeral });
      return;
    }
    const chosenIndex = Number(indexRaw);
    const answer = application.answers[application.currentIndex];
    const chosen = answer?.options?.[chosenIndex];
    const result = await this.service.submitChoiceAnswer(applicationId, questionId, chosenIndex);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("Answer recorded").setDescription(`${answer?.prompt ?? ""}\n\nYou chose: ${chosen ? `${chosen.emoji} **${chosen.label}**` : "—"}`)], components: [] });
    await this.afterAnswer(applicationId, result.status);
  }

  private async afterAnswer(applicationId: string, status: "ASK" | "SUBMITTED"): Promise<void> {
    const application = this.store.getApplication(applicationId);
    if (!application) return;
    if (status === "ASK") {
      await this.postCurrentQuestion(application);
      return;
    }
    await this.postReview(application);
    if (application.threadId) {
      const thread = await this.fetchThread(application.threadId);
      await thread?.send("✅ **Application submitted!** A supervisor will review it soon. Thanks!");
    }
  }

  // ------------------------------------------------------------------ review

  private async postReview(application: Application): Promise<void> {
    const settings = this.store.getSettings();
    if (!settings.reviewChannelId) {
      console.warn("Demo: no review channel configured; application submitted but not posted for review");
      return;
    }
    const channel = await this.fetchTextChannel(settings.reviewChannelId);
    if (!channel) return;
    const sent = await channel.send({ embeds: [this.reviewEmbed(application)], components: [this.reviewButtons(application.id)] });
    await this.store.updateApplication(application.id, { reviewMessageId: sent.id });
  }

  private reviewEmbed(application: Application): EmbedBuilder {
    const score = application.score ?? { correct: 0, total: 0 };
    const flag = score.total > 0 ? (passed(score, this.service.getPassingScore()) ? "✅ pass" : "⚠️ below bar") : "n/a";
    const lines = application.answers.map((answer, i) => {
      if (answer.kind === "TEXT") return `**${i + 1}. ${answer.prompt}**\n> ${(answer.text ?? "—").slice(0, 300)}`;
      const chosen = answer.chosenIndex !== null ? answer.options?.[answer.chosenIndex] : undefined;
      const mark = answer.correct ? "✅" : "❌";
      return `**${i + 1}. ${answer.prompt}**\n> ${chosen ? `${chosen.emoji} ${chosen.label}` : "—"} ${mark}`;
    });
    return new EmbedBuilder()
      .setTitle(`📋 ${RANKS[application.targetRank].label} application`)
      .setDescription(`👤 <@${application.discordUserId}> · Roblox **${application.robloxUsername ?? "?"}**\n🎯 Track: ${application.track}`)
      .addFields(
        { name: "Practical score", value: `${score.correct}/${score.total} (${flag})`, inline: true },
        { name: "Answers", value: lines.join("\n\n").slice(0, 1024) || "—" },
      );
  }

  private reviewButtons(applicationId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`staff-accept:${applicationId}`).setStyle(ButtonStyle.Success).setLabel("Accept").setEmoji("✅"),
      new ButtonBuilder().setCustomId(`staff-reject:${applicationId}`).setStyle(ButtonStyle.Danger).setLabel("Reject").setEmoji("❌"),
    );
  }

  private async handleAccept(interaction: ButtonInteraction): Promise<void> {
    const applicationId = interaction.customId.slice("staff-accept:".length);
    await interaction.deferUpdate();
    const actor = resolveActor(interaction, this.store);
    const application = this.store.getApplication(applicationId);
    if (!application) throw new DemoError("Application not found.");
    const result = await this.service.decide({ applicationId, actor, accept: true });
    let roleNote = "";
    if (result.discordRoleId && interaction.guildId) roleNote = await this.setRole(interaction.guildId, application.discordUserId, result.discordRoleId, true);
    const sync = result.rankSync;
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("✅ Accepted").setDescription(
        `<@${application.discordUserId}> hired as **${RANKS[application.targetRank].label}**.\n` +
        `Roblox rank: ${sync ? (sync.ok ? (sync.dryRun ? "🟡 dry-run" : "🟢 synced") : `🔴 ${sync.message}`) : "n/a"}\n` +
        (roleNote ? `Discord role: ${roleNote}` : ""),
      )],
      components: [],
    });
    await this.notifyApplicant(application, `🎉 Your **${RANKS[application.targetRank].label}** application was **accepted**! Welcome aboard.`);
  }

  private async handleRejectModalOpen(interaction: ButtonInteraction): Promise<void> {
    const applicationId = interaction.customId.slice("staff-reject:".length);
    const modal = new ModalBuilder().setCustomId(`staff-reject-modal:${applicationId}`).setTitle("Reject application").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason (shown to the applicant)").setStyle(TextInputStyle.Paragraph).setRequired(false)),
    );
    await interaction.showModal(modal);
  }

  private async handleRejectModal(interaction: ModalSubmitInteraction): Promise<void> {
    const applicationId = interaction.customId.slice("staff-reject-modal:".length);
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const actor = resolveActor(interaction, this.store);
    const application = this.store.getApplication(applicationId);
    if (!application) throw new DemoError("Application not found.");
    await this.service.decide({ applicationId, actor, accept: false, reason });
    if (interaction.isFromMessage()) await interaction.update({ embeds: [new EmbedBuilder().setTitle("❌ Rejected").setDescription(`<@${application.discordUserId}>'s application was rejected.${reason ? `\nReason: ${reason}` : ""}`)], components: [] });
    else await interaction.reply({ content: "Application rejected.", flags: MessageFlags.Ephemeral });
    await this.notifyApplicant(application, `Your **${RANKS[application.targetRank].label}** application was **not accepted** this time.${reason ? `\nReason: ${reason}` : ""}`);
  }

  private async notifyApplicant(application: Application, message: string): Promise<void> {
    if (application.threadId) {
      const thread = await this.fetchThread(application.threadId);
      if (thread) { await thread.send(message).catch(() => undefined); return; }
    }
    const user = await this.client.users.fetch(application.discordUserId).catch(() => null);
    await user?.send(message).catch(() => undefined);
  }

  // ------------------------------------------------------------------ promote / demote

  private async assignRank(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser("user", true);
    const rankValue = interaction.options.getString("rank", true);
    if (!isRankCode(rankValue)) throw new DemoError("Unknown rank.");
    const actor = resolveActor(interaction, this.store);
    const result = await this.service.assignRank({ actor, targetDiscordId: user.id, newRank: rankValue });
    if (interaction.guildId) {
      if (result.removeRoleId) await this.setRole(interaction.guildId, user.id, result.removeRoleId, false);
      if (result.addRoleId) await this.setRole(interaction.guildId, user.id, result.addRoleId, true);
    }
    const sync = result.rankSync;
    await interaction.editReply({ content: `${result.created ? "🆕 Assigned" : "🔁 Set"} <@${user.id}> as **${RANKS[rankValue].label}**.\nRoblox rank: ${sync.ok ? (sync.dryRun ? "🟡 dry-run" : "🟢 synced") : `🔴 ${sync.message}`}` });
  }

  private async setRank(interaction: ChatInputCommandInteraction, mode: "promote" | "demote"): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser("user", true);
    const rankValue = interaction.options.getString("rank", true);
    if (!isRankCode(rankValue)) throw new DemoError("Unknown rank.");
    const member = this.store.getStaffByDiscord(user.id);
    if (!member) throw new DemoError("That user is not a staff member.");
    const currentOrder = RANKS[member.rank].order;
    const nextOrder = RANKS[rankValue].order;
    if (mode === "promote" && nextOrder <= currentOrder) throw new DemoError(`${RANKS[rankValue].short} is not a promotion from ${member.rank}. Use /staff demote instead.`);
    if (mode === "demote" && nextOrder >= currentOrder) throw new DemoError(`${RANKS[rankValue].short} is not a demotion from ${member.rank}. Use /staff promote instead.`);

    const actor = resolveActor(interaction, this.store);
    const result = await this.service.setMemberRank({ actor, targetDiscordId: user.id, newRank: rankValue });
    if (interaction.guildId) {
      if (result.removeRoleId) await this.setRole(interaction.guildId, user.id, result.removeRoleId, false);
      if (result.addRoleId) await this.setRole(interaction.guildId, user.id, result.addRoleId, true);
    }
    const sync = result.rankSync;
    await interaction.editReply({ content: `${mode === "promote" ? "⬆️ Promoted" : "⬇️ Demoted"} <@${user.id}> to **${RANKS[rankValue].label}**.\nRoblox rank: ${sync.ok ? (sync.dryRun ? "🟡 dry-run" : "🟢 synced") : `🔴 ${sync.message}`}` });
  }

  // ------------------------------------------------------------------ view / roster

  private async staffView(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const actor = resolveActor(interaction, this.store);
    if (target.id !== interaction.user.id && !hasBotLevel(actor, PermissionLevel.STAFF)) throw new DemoError("Staff role required to view other members.");
    const member = this.store.getStaffByDiscord(target.id);
    if (!member) { await interaction.reply({ content: `<@${target.id}> is not a staff member.`, flags: MessageFlags.Ephemeral }); return; }
    const def = RANKS[member.rank];
    const embed = new EmbedBuilder().setTitle(`${def.label} (${def.short})`).setDescription(`👤 <@${member.discordUserId}> · Roblox **${member.robloxUsername}**`).addFields(
      { name: "Track", value: def.track, inline: true },
      { name: "Probation", value: member.probation ? "Yes" : "No", inline: true },
      { name: "Hired", value: `<t:${Math.floor(new Date(member.hiredAt).getTime() / 1000)}:D> by <@${member.hiredBy}>`, inline: false },
    );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  private async staffRoster(interaction: ChatInputCommandInteraction): Promise<void> {
    const actor = resolveActor(interaction, this.store);
    if (!hasBotLevel(actor, PermissionLevel.STAFF)) throw new DemoError("Staff role required.");
    const staff = this.store.listStaff();
    const byRank = RANK_CODES.map((code) => {
      const members = staff.filter((m) => m.rank === code);
      if (!members.length) return null;
      return `**${RANKS[code].label}** (${code})\n${members.map((m) => `• <@${m.discordUserId}> — ${m.robloxUsername}${m.probation ? " · 🟡 probation" : ""}`).join("\n")}`;
    }).filter((line): line is string => line !== null);
    const embed = new EmbedBuilder().setTitle("👥 Staff roster").setDescription(byRank.join("\n\n") || "No staff hired yet.");
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ------------------------------------------------------------------ config panel

  private async openConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    this.requireManager(interaction);
    await interaction.reply({ ...this.configPanel(), flags: MessageFlags.Ephemeral });
  }

  private configPanel(): Payload {
    const settings = this.store.getSettings();
    const mappings = RANK_CODES.map((code) => {
      const cfg = this.store.getRankConfig(code);
      return `**${code}** — role ${cfg.discordRoleId ? `<@&${cfg.discordRoleId}>` : "—"} · group role \`${cfg.groupRoleId ?? "—"}\``;
    }).join("\n");
    const embed = new EmbedBuilder().setTitle("⚙️ Staffing configuration").addFields(
      { name: "Applications channel", value: settings.applicationsChannelId ? `<#${settings.applicationsChannelId}>` : "Not set", inline: true },
      { name: "Review channel", value: settings.reviewChannelId ? `<#${settings.reviewChannelId}>` : "Not set", inline: true },
      { name: "Rank mappings", value: mappings },
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId("cfg-apps-channel").setPlaceholder("Applications channel").addChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId("cfg-review-channel").setPlaceholder("Review channel").addChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("cfg-pick-rank").setPlaceholder("Configure a rank's roles").addOptions(RANK_CODES.map((code) => ({ label: `${code} — ${RANKS[code].label}`, value: code })))),
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("cfg-close").setStyle(ButtonStyle.Secondary).setLabel("Close").setEmoji("✖️")),
      ],
    };
  }

  private rankSubPanel(code: RankCode): Payload {
    const cfg = this.store.getRankConfig(code);
    const embed = new EmbedBuilder().setTitle(`⚙️ Configure ${RANKS[code].label} (${code})`).setDescription(
      `Discord role: ${cfg.discordRoleId ? `<@&${cfg.discordRoleId}>` : "—"}\nRoblox group role id: \`${cfg.groupRoleId ?? "—"}\``,
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`cfg-set-role:${code}`).setPlaceholder("Set the Discord role")),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`cfg-set-grouprole:${code}`).setStyle(ButtonStyle.Primary).setLabel("Set Roblox group role id").setEmoji("🧩"),
          new ButtonBuilder().setCustomId("cfg-back").setStyle(ButtonStyle.Secondary).setLabel("Back").setEmoji("↩️"),
        ),
      ],
    };
  }

  // ------------------------------------------------------------------ questions editor

  private async openQuestions(interaction: ChatInputCommandInteraction): Promise<void> {
    this.requireManager(interaction);
    await interaction.reply({ ...this.questionsPanel("ALL"), flags: MessageFlags.Ephemeral });
  }

  private questionsPanel(filter: "ALL" | "SURFER" | "ENGINEER" | "BOTH"): Payload {
    const questions = this.store.listQuestions().filter((q) => filter === "ALL" || q.track === filter);
    const list = questions.map((q, i) => `**${i + 1}.** [${q.track}/${q.kind}]${q.active ? "" : " 💤"} ${q.prompt.slice(0, 70)}`).join("\n") || "No questions for this filter.";
    const addTrack = filter === "ALL" ? "BOTH" : filter;
    const embed = new EmbedBuilder().setTitle("🧾 Application questions").setDescription(list).setFooter({ text: `Filter: ${filter} · new questions added as: ${addTrack}` });
    const components: Payload["components"] = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("q-track").setPlaceholder("Filter by track").addOptions(
        { label: "All", value: "ALL" }, { label: "Surfer", value: "SURFER" }, { label: "Engineer", value: "ENGINEER" }, { label: "Both", value: "BOTH" },
      )),
    ];
    if (questions.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`q-pick:${filter}`).setPlaceholder("Select a question to edit").addOptions(
        questions.slice(0, 25).map((q, i) => ({ label: `${i + 1}. ${q.prompt}`.slice(0, 100), value: q.id })),
      )));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`q-add-text:${addTrack}`).setStyle(ButtonStyle.Success).setLabel("Add text").setEmoji("✍️"),
      new ButtonBuilder().setCustomId(`q-add-choice:${addTrack}`).setStyle(ButtonStyle.Success).setLabel("Add practical").setEmoji("🎛️"),
      new ButtonBuilder().setCustomId("q-close").setStyle(ButtonStyle.Secondary).setLabel("Close").setEmoji("✖️"),
    ));
    return { embeds: [embed], components };
  }

  private questionDetail(id: string, filter: string): Payload {
    const q = this.store.getQuestion(id);
    if (!q) throw new DemoError("Question not found.");
    const optionText = q.options?.map((o) => `${o.emoji} ${o.label}${o.correct ? " ✅" : ""}`).join("\n") ?? "—";
    const embed = new EmbedBuilder().setTitle(`Question · ${q.track}/${q.kind}`).setDescription(q.prompt).addFields(
      { name: "Active", value: q.active ? "Yes" : "No", inline: true },
      ...(q.kind === "CHOICE" ? [{ name: "Options", value: optionText }] : []),
    );
    if (q.imageUrl) embed.setImage(q.imageUrl);
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`q-move:up:${id}`).setStyle(ButtonStyle.Secondary).setLabel("Up").setEmoji("⬆️"),
          new ButtonBuilder().setCustomId(`q-move:down:${id}`).setStyle(ButtonStyle.Secondary).setLabel("Down").setEmoji("⬇️"),
          new ButtonBuilder().setCustomId(`q-toggle:${id}`).setStyle(ButtonStyle.Primary).setLabel(q.active ? "Disable" : "Enable").setEmoji(q.active ? "💤" : "✅"),
          new ButtonBuilder().setCustomId(`q-remove:${id}`).setStyle(ButtonStyle.Danger).setLabel("Remove").setEmoji("🗑️"),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`q-back:${filter}`).setStyle(ButtonStyle.Secondary).setLabel("Back").setEmoji("↩️")),
      ],
    };
  }

  private addTextModal(track: string): ModalBuilder {
    return new ModalBuilder().setCustomId(`q-add-text-modal:${track}`).setTitle("Add text question").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("prompt").setLabel("Question prompt").setStyle(TextInputStyle.Paragraph).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Answer style: short or paragraph").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("paragraph")),
    );
  }

  private addChoiceModal(track: string): ModalBuilder {
    return new ModalBuilder().setCustomId(`q-add-choice-modal:${track}`).setTitle("Add practical question").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("prompt").setLabel("Question prompt").setStyle(TextInputStyle.Paragraph).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Image URL (optional)").setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("options").setLabel("Options (emoji | label | correct)").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("One per line, e.g.\n🔼 | Up | correct\n🔽 | Down")),
    );
  }

  // ------------------------------------------------------------------ component handlers

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const id = interaction.customId;
    if (id.startsWith("apply-answer:")) return this.handleAnswerButton(interaction);
    if (id.startsWith("staff-accept:")) return this.handleAccept(interaction);
    if (id.startsWith("staff-reject:")) return this.handleRejectModalOpen(interaction);

    if (id === "cfg-close" || id === "q-close") { await interaction.update({ content: "Closed.", embeds: [], components: [] }); return; }
    if (id === "cfg-back") { this.requireManager(interaction); await interaction.update(this.configPanel()); return; }
    if (id.startsWith("cfg-set-grouprole:")) {
      this.requireManager(interaction);
      const code = id.slice("cfg-set-grouprole:".length);
      const modal = new ModalBuilder().setCustomId(`cfg-grouprole-modal:${code}`).setTitle(`Group role id for ${code}`).addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("roleId").setLabel("Roblox group role id").setStyle(TextInputStyle.Short).setRequired(true)),
      );
      await interaction.showModal(modal);
      return;
    }
    if (id.startsWith("q-add-text:")) { this.requireManager(interaction); await interaction.showModal(this.addTextModal(id.slice("q-add-text:".length))); return; }
    if (id.startsWith("q-add-choice:")) { this.requireManager(interaction); await interaction.showModal(this.addChoiceModal(id.slice("q-add-choice:".length))); return; }
    if (id.startsWith("q-move:")) {
      this.requireManager(interaction);
      const [, direction, questionId] = id.split(":");
      await this.service.moveQuestion(questionId ?? "", direction === "up" ? "up" : "down");
      await interaction.update(this.questionDetail(questionId ?? "", "ALL"));
      return;
    }
    if (id.startsWith("q-toggle:")) {
      this.requireManager(interaction);
      const questionId = id.slice("q-toggle:".length);
      const q = this.store.getQuestion(questionId);
      if (!q) throw new DemoError("Question not found.");
      await this.service.setQuestionActive(questionId, !q.active);
      await interaction.update(this.questionDetail(questionId, "ALL"));
      return;
    }
    if (id.startsWith("q-remove:")) {
      this.requireManager(interaction);
      await this.service.removeQuestion(id.slice("q-remove:".length));
      await interaction.update(this.questionsPanel("ALL"));
      return;
    }
    if (id.startsWith("q-back:")) { this.requireManager(interaction); await interaction.update(this.questionsPanel("ALL")); return; }
  }

  private async handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const id = interaction.customId;
    if (id === "cfg-pick-rank") {
      this.requireManager(interaction);
      const code = interaction.values[0];
      if (!code || !isRankCode(code)) throw new DemoError("Unknown rank.");
      await interaction.update(this.rankSubPanel(code));
      return;
    }
    if (id === "q-track") {
      this.requireManager(interaction);
      const value = interaction.values[0] ?? "ALL";
      const filter = value === "SURFER" || value === "ENGINEER" || value === "BOTH" ? value : "ALL";
      await interaction.update(this.questionsPanel(filter));
      return;
    }
    if (id.startsWith("q-pick:")) {
      this.requireManager(interaction);
      const questionId = interaction.values[0];
      if (!questionId) throw new DemoError("No question selected.");
      await interaction.update(this.questionDetail(questionId, id.slice("q-pick:".length)));
      return;
    }
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    this.requireManager(interaction);
    const channelId = interaction.values[0];
    if (!channelId) throw new DemoError("No channel selected.");
    if (interaction.customId === "cfg-apps-channel") await this.store.setApplicationsChannel(channelId);
    else if (interaction.customId === "cfg-review-channel") await this.store.setReviewChannel(channelId);
    await interaction.update(this.configPanel());
  }

  private async handleRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    this.requireManager(interaction);
    if (!interaction.customId.startsWith("cfg-set-role:")) return;
    const code = interaction.customId.slice("cfg-set-role:".length);
    if (!isRankCode(code)) throw new DemoError("Unknown rank.");
    const roleId = interaction.values[0];
    if (!roleId) throw new DemoError("No role selected.");
    await this.store.setRankConfig(code, { discordRoleId: roleId });
    await interaction.update(this.rankSubPanel(code));
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const id = interaction.customId;
    if (id.startsWith("staff-reject-modal:")) return this.handleRejectModal(interaction);
    if (id.startsWith("cfg-grouprole-modal:")) {
      this.requireManager(interaction);
      const code = id.slice("cfg-grouprole-modal:".length);
      if (!isRankCode(code)) throw new DemoError("Unknown rank.");
      await this.store.setRankConfig(code, { groupRoleId: interaction.fields.getTextInputValue("roleId").trim() });
      await interaction.reply({ content: `Saved Roblox group role id for ${code}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.startsWith("q-add-text-modal:")) {
      this.requireManager(interaction);
      const track = this.normalizeTrack(id.slice("q-add-text-modal:".length));
      const style = interaction.fields.getTextInputValue("style").trim().toUpperCase() === "SHORT" ? "SHORT" : "PARAGRAPH";
      await this.service.addTextQuestion({ track, prompt: interaction.fields.getTextInputValue("prompt"), style, required: true });
      await interaction.reply({ content: "✅ Text question added.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.startsWith("q-add-choice-modal:")) {
      this.requireManager(interaction);
      const track = this.normalizeTrack(id.slice("q-add-choice-modal:".length));
      const options = parseChoiceOptions(interaction.fields.getTextInputValue("options"));
      const image = interaction.fields.getTextInputValue("image").trim();
      await this.service.addChoiceQuestion({ track, prompt: interaction.fields.getTextInputValue("prompt"), imageUrl: image || null, options, required: true });
      await interaction.reply({ content: `✅ Practical question added with ${options.length} options.`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  // ------------------------------------------------------------------ helpers

  private normalizeTrack(value: string): "SURFER" | "ENGINEER" | "BOTH" {
    return value === "SURFER" || value === "ENGINEER" ? value : "BOTH";
  }

  private requireManager(interaction: Interaction): void {
    const actor = resolveActor(interaction, this.store);
    if (!hasBotLevel(actor, PermissionLevel.MANAGER)) throw new DemoError("Manager access required.");
  }

  private async fetchTextChannel(channelId: string): Promise<TextChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    return channel && channel.type === ChannelType.GuildText ? channel : null;
  }

  private async fetchThread(threadId: string) {
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel && channel.isThread() ? channel : null;
  }

  private async setRole(guildId: string, userId: string, roleId: string, add: boolean): Promise<string> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      if (add) await member.roles.add(roleId); else await member.roles.remove(roleId);
      return add ? `added <@&${roleId}>` : `removed <@&${roleId}>`;
    } catch {
      return `⚠️ could not ${add ? "add" : "remove"} <@&${roleId}> (check bot role position & Manage Roles)`;
    }
  }
}
