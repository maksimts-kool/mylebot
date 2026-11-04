import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Message,
  type MessageActionRowComponentBuilder, type StringSelectMenuInteraction,
} from "discord.js";
import { userError } from "../../../../core/errors.js";
import { BRAND_COLOR } from "../../../../shared/discord/colors.js";
import { PermissionLevel } from "../../../../shared/permissions.js";
import { totalsForPeriod } from "../../domain/accounting.js";
import { recordedTimeMeetsSessionMinimum, sessionMeetsMinimum } from "../../domain/policy.js";
import { sessionOwner, statusIcon, statusLabel } from "../session-embed.js";
import type { SessionCommandContext } from "./context.js";
import { formatSessionDateTime, friendlyDuration } from "./format.js";

const PAGE_SIZE = 10;

/** Discord allows 25 options in a select menu; a page never lists more than ten. */
const MANAGE_OPTION_LIMIT = 25;

/** Component ids the history message carries. The handler routes on these. */
export const HISTORY_IDS = {
  page: "historypage:",
  manage: "session:manage",
  /** `session:add:i:<identityId>` for a tracked member, `session:add:u:<discordUserId>` otherwise. */
  add: "session:add:",
} as const;

/**
 * Whose history to show: somebody the tracker has recorded, or a
 * Bloxlink-mapped member it has never seen. The second has no sessions, but an
 * Admin can still add their first one from it.
 */
export type HistorySubject = { identityId: string } | { discordUserId: string };

/**
 * `public` posts in the channel with controls only the caller can use;
 * `private` answers only the caller. A slash command is public, a button on the
 * logs channel's record is private so the record channel stays a record.
 */
export type HistoryVisibility = "public" | "private";

type HistoryInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

type HistoryResponse = {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<MessageActionRowComponentBuilder>>;
};

export function addCustomId(subject: HistorySubject): string {
  return "identityId" in subject ? `${HISTORY_IDS.add}i:${subject.identityId}` : `${HISTORY_IDS.add}u:${subject.discordUserId}`;
}

/** Reads `addCustomId` back. `null` when the id is not an add control. */
export function parseAddCustomId(customId: string): HistorySubject | null {
  if (!customId.startsWith(HISTORY_IDS.add)) return null;
  const [kind, id] = customId.slice(HISTORY_IDS.add.length).split(":");
  if (!id) return null;
  if (kind === "i") return { identityId: id };
  if (kind === "u") return { discordUserId: id };
  return null;
}

async function renderHistory(
  ctx: SessionCommandContext,
  interaction: HistoryInteraction,
  subject: HistorySubject,
  requestedPage: number,
): Promise<HistoryResponse> {
  const now = new Date();
  const canManage = await ctx.hasPermission(interaction, PermissionLevel.ADMIN);

  let owner: string;
  let sessions: Awaited<ReturnType<typeof loadSessions>> = [];
  if ("identityId" in subject) {
    const identity = await ctx.db.identity.findUnique({ where: { id: subject.identityId } });
    if (!identity) userError("No sessions found");
    owner = sessionOwner(identity);
    sessions = (await loadSessions(ctx, subject.identityId)).filter((session) => sessionMeetsMinimum(session, now));
  } else {
    owner = `<@${subject.discordUserId}>`;
  }

  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  // A removal can leave the caller on a page that no longer exists.
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const shown = sessions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const description = shown.length
    ? shown.map((session) => {
      const end = session.endedAt ?? now;
      const totals = totalsForPeriod(session.segments, session.startedAt, end, end);
      const timing = session.endedAt
        ? `Started <t:${Math.floor(session.startedAt.getTime() / 1000)}:f> and ended <t:${Math.floor(session.endedAt.getTime() / 1000)}:R>`
        : `Started <t:${Math.floor(session.startedAt.getTime() / 1000)}:R>`;
      return `${statusIcon(session.state)} **${statusLabel(session.state)}**\n🗓️ ${timing}\n⏱️ ${friendlyDuration(totals.totalMs)} total · ${friendlyDuration(totals.activeMs)} active · ${friendlyDuration(totals.inactiveMs)} inactive\n🆔 Session ID: \`${session.id}\``;
    }).join("\n\n")
    : "👥 No sessions recorded yet.";

  const components: Array<ActionRowBuilder<MessageActionRowComponentBuilder>> = [];

  // Live sessions belong to the lifecycle, so only completed ones are offered.
  const manageable = canManage
    ? shown.filter((session) => session.state === "ENDED" && recordedTimeMeetsSessionMinimum(session.activeMilliseconds, session.inactiveMilliseconds))
    : [];
  if (manageable.length) {
    components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(HISTORY_IDS.manage)
        .setPlaceholder("🛠️ Edit or remove a completed session")
        .addOptions(manageable.slice(0, MANAGE_OPTION_LIMIT).map((session) => ({
          label: `${formatSessionDateTime(session.startedAt, ctx.config.REPORT_TIMEZONE)} · ${friendlyDuration(Number(session.activeMilliseconds) + Number(session.inactiveMilliseconds))}`.slice(0, 100),
          description: session.id,
          value: session.id,
        }))),
    ));
  }

  const buttons: ButtonBuilder[] = [];
  if (pageCount > 1 && "identityId" in subject) {
    buttons.push(
      new ButtonBuilder().setCustomId(`${HISTORY_IDS.page}${subject.identityId}:${page - 1}`).setLabel("Previous").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`${HISTORY_IDS.page}${subject.identityId}:${page + 1}`).setLabel("Next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= pageCount),
    );
  }
  if (canManage) {
    buttons.push(new ButtonBuilder().setCustomId(addCustomId(subject)).setLabel("Add session").setEmoji("➕").setStyle(ButtonStyle.Success));
  }
  if (buttons.length) components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons));

  return {
    embeds: [new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle("📚 Session history")
      .setDescription(`👤 ${owner}\n\n${description}`)
      .setFooter({ text: `Page ${page + 1} of ${pageCount}` })],
    components,
  };
}

function loadSessions(ctx: SessionCommandContext, identityId: string) {
  return ctx.db.session.findMany({
    where: { identityId, deletedAt: null },
    include: { segments: true },
    orderBy: { startedAt: "desc" },
  });
}

/** Public controls go quiet once the caller stops using them. */
function trackPublic(ctx: SessionCommandContext, message: Message, userId: string): void {
  ctx.publicComponents.track(message.id, userId, async () => {
    await message.edit({ components: [] });
  });
}

/** Answers with a history as a new message. */
export async function replyHistory(
  ctx: SessionCommandContext,
  interaction: HistoryInteraction,
  subject: HistorySubject,
  visibility: HistoryVisibility,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(visibility === "private" ? { flags: MessageFlags.Ephemeral } : {});
  }
  const message = await interaction.editReply(await renderHistory(ctx, interaction, subject, 0));
  if (visibility === "public") trackPublic(ctx, message, interaction.user.id);
}

/** Moves the history a button sits on to another page, in place. */
export async function updateHistoryPage(
  ctx: SessionCommandContext,
  interaction: ButtonInteraction,
  identityId: string,
  page: number,
): Promise<void> {
  await interaction.deferUpdate();
  const message = await interaction.editReply(await renderHistory(ctx, interaction, { identityId }, page));
  if (!interaction.message.flags.has(MessageFlags.Ephemeral)) trackPublic(ctx, message, interaction.user.id);
}
