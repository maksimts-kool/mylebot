import { Prisma, type TaigaCard, type TaigaCardKind } from "@prisma/client";
import { ChannelType, type AnyThreadChannel, type Client } from "discord.js";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import { TaigaApiError, type TaigaClient, type TaigaEpic } from "../client.js";
import {
  DECLINED_TAGS, INITIAL_COLUMN, KNOWN_COLUMNS, KNOWN_FORUM_TAGS, isKnownColumn, isShippedColumn,
  sameName, shouldArchiveForColumn, tagsForColumn,
} from "../domain/mapping.js";
import { reconcileCards } from "../domain/reconcile.js";
import { buildStoryDescription, buildStorySubject } from "../domain/story.js";
import { currentColumn, type TaigaWebhookPayload } from "../domain/webhook.js";
import { applyForumState, fetchForumChannel, resolveTagIds } from "../discord/tags.js";
import type { TaigaNotifier } from "../discord/notifications.js";
import type { TaigaSettingsService } from "./settings.js";

export type HealthReport = {
  enabled: boolean;
  trackedCards: number;
  missingColumns: string[];
  missingTags: string[];
  problems: string[];
};

export class TaigaSyncService {
  constructor(
    private readonly db: Db,
    private readonly client: Client,
    private readonly taiga: TaigaClient,
    private readonly settings: TaigaSettingsService,
    private readonly notifier: TaigaNotifier,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ---------------------------------------------------------------- Discord → Taiga

  /**
   * A new forum post becomes a card in the first column. Posts that predate the
   * integration being switched on are ignored, so enabling it never back-fills
   * the existing forums.
   */
  async handleThreadCreated(thread: AnyThreadChannel): Promise<void> {
    const settings = await this.settings.get();
    if (!settings.enabled || !settings.activatedAt) return;
    const kind = this.kindForChannel(thread.parentId, settings.bugForumChannelId, settings.suggestionForumChannelId);
    if (!kind) return;
    const createdAt = thread.createdAt ?? new Date();
    if (createdAt < settings.activatedAt) return;

    const existing = await this.db.taigaCard.findUnique({ where: { threadId: thread.id } });
    if (existing) return;

    const starter = await thread.fetchStarterMessage().catch(() => null);
    const author = starter?.author ?? (thread.ownerId ? await this.client.users.fetch(thread.ownerId).catch(() => null) : null);
    if (!author) {
      this.log.warn({ feature: "taiga", threadId: thread.id }, "Forum post has no resolvable author; skipping card creation");
      return;
    }
    if (starter && !starter.content) {
      // Empty content on a real message means the privileged MessageContent
      // intent is missing or the post genuinely had only attachments.
      this.log.warn({ feature: "taiga", threadId: thread.id }, "Forum post starter message had no readable content");
    }

    const statusId = await this.statusIdFor(INITIAL_COLUMN);
    const story = await this.taiga.createUserStory({
      subject: buildStorySubject(thread.name),
      description: buildStoryDescription({
        body: starter?.content ?? "",
        guildId: thread.guildId,
        threadId: thread.id,
        author: { discordId: author.id, name: author.displayName || author.username },
      }),
      ...(statusId === undefined ? {} : { statusId }),
      tags: [kind === "BUG" ? "bug" : "suggestion"],
    });

    const card = await this.db.taigaCard.create({
      data: {
        taigaStoryId: story.id,
        taigaRef: story.ref,
        guildId: thread.guildId,
        channelId: thread.parentId ?? "",
        threadId: thread.id,
        kind,
        title: buildStorySubject(thread.name),
        statusName: INITIAL_COLUMN,
        authorDiscordId: author.id,
        authorName: author.displayName || author.username,
      },
    });
    this.log.info({ feature: "taiga", threadId: thread.id, taigaRef: story.ref, kind }, "Taiga card created for forum post");
    await this.applyColumnToPost(card, INITIAL_COLUMN);
    await this.notifier.cardCreated(card);
  }

  /** Deleting the post deletes the card. */
  async handleThreadDeleted(threadId: string): Promise<void> {
    const card = await this.db.taigaCard.findUnique({ where: { threadId } });
    if (!card) return;
    // Flag first: the delete we are about to make in Taiga fires a webhook back
    // at us, and it must not be read as somebody declining the card.
    await this.db.taigaCard.update({ where: { id: card.id }, data: { deleting: true } });
    try {
      await this.taiga.deleteUserStory(card.taigaStoryId);
    } catch (error) {
      // A 404 means it is already gone, which is the state we wanted.
      if (!(error instanceof TaigaApiError) || error.status !== 404) {
        this.log.error({ feature: "taiga", threadId, errorType: errorType(error) }, "Deleting the Taiga card failed");
        await this.db.taigaCard.update({ where: { id: card.id }, data: { deleting: false } });
        return;
      }
    }
    await this.db.taigaCard.delete({ where: { id: card.id } });
    this.log.info({ feature: "taiga", threadId, taigaRef: card.taigaRef }, "Taiga card removed with its forum post");
    await this.notifier.postRemoved(card);
  }

  // ---------------------------------------------------------------- Taiga → Discord

  /** Applies one webhook delivery. Returns false when it was a replay. */
  async handleWebhook(payload: TaigaWebhookPayload, fingerprint: string): Promise<boolean> {
    if (payload.action === "test") return true;
    if (!await this.claimDelivery(fingerprint)) return false;
    if (payload.type === "epic") {
      await this.handleEpicEvent(payload);
      return true;
    }
    if (payload.type !== "userstory") return true;

    const card = await this.db.taigaCard.findUnique({ where: { taigaStoryId: payload.data.id } });
    if (!card) return true; // A card with no forum post behind it is not ours to report on.

    if (payload.action === "delete") {
      await this.handleCardDeleted(card);
      return true;
    }
    if (payload.action === "create" || payload.action === "change") {
      const column = currentColumn(payload);
      if (!column || sameName(column, card.statusName)) return true;
      await this.applyColumnChange(card, column);
    }
    return true;
  }

  private async handleCardDeleted(card: TaigaCard): Promise<void> {
    if (card.deleting) return; // Our own deletion, already reported.
    if (isShippedColumn(card.statusName)) {
      // Clearing a shipped card off the board is housekeeping, not a rejection:
      // the post keeps its Approved tag and we simply stop tracking it.
      await this.db.taigaCard.delete({ where: { id: card.id } });
      this.log.info({ feature: "taiga", taigaRef: card.taigaRef }, "Shipped Taiga card removed from the board");
      await this.notifier.shippedCardRemoved(card);
      return;
    }
    const updated = await this.db.taigaCard.update({ where: { id: card.id }, data: { declinedAt: new Date() } });
    await this.applyPostState(updated, DECLINED_TAGS, true);
    this.log.info({ feature: "taiga", taigaRef: card.taigaRef, lastColumn: card.statusName }, "Taiga card deleted; post marked declined");
    await this.notifier.cardDeclined(updated);
  }

  private async applyColumnChange(card: TaigaCard, column: string): Promise<void> {
    const from = card.statusName;
    const updated = await this.db.taigaCard.update({ where: { id: card.id }, data: { statusName: column } });
    await this.applyColumnToPost(updated, column);
    this.log.info({ feature: "taiga", taigaRef: card.taigaRef, from, to: column }, "Taiga card moved");
    await this.notifier.cardMoved(updated, from, column);
  }

  /** Records a delivery, returning false when this exact body was already applied. */
  private async claimDelivery(fingerprint: string): Promise<boolean> {
    try {
      await this.db.taigaWebhookDelivery.create({ data: { fingerprint } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  // ---------------------------------------------------------------- Epics (report only)

  private async handleEpicEvent(payload: TaigaWebhookPayload): Promise<void> {
    const epic: TaigaEpic = {
      id: payload.data.id,
      ref: payload.data.ref ?? 0,
      subject: payload.data.subject ?? "",
      statusName: payload.data.status?.name ?? null,
      isClosed: payload.data.status?.is_closed === true || payload.data.is_closed === true,
    };
    if (payload.action === "delete") {
      await this.db.taigaEpicState.deleteMany({ where: { taigaEpicId: epic.id } });
      return;
    }
    await this.recordEpic(epic, { announce: true });
  }

  /**
   * Stores the epic's state and announces genuine transitions. Both the webhook
   * and the reconcile sweep funnel through here, so a change is announced once
   * regardless of which path noticed it first.
   */
  private async recordEpic(epic: TaigaEpic, { announce }: { announce: boolean }): Promise<void> {
    const previous = await this.db.taigaEpicState.findUnique({ where: { taigaEpicId: epic.id } });
    const unchanged = previous
      && previous.isClosed === epic.isClosed
      && (previous.statusName ?? null) === epic.statusName
      && previous.subject === epic.subject;
    await this.db.taigaEpicState.upsert({
      where: { taigaEpicId: epic.id },
      create: { taigaEpicId: epic.id, ref: epic.ref, subject: epic.subject, statusName: epic.statusName, isClosed: epic.isClosed },
      update: { ref: epic.ref, subject: epic.subject, statusName: epic.statusName, isClosed: epic.isClosed },
    });
    if (!announce || unchanged) return;

    const action = !previous ? "created" : epic.isClosed && !previous.isClosed ? "closed" : "updated";
    const related = action === "closed" ? await this.relatedCards(epic.id) : [];
    await this.notifier.epicEvent(epic, action, related);
  }

  private async relatedCards(epicId: number): Promise<TaigaCard[]> {
    try {
      const stories = await this.taiga.epicUserStories(epicId);
      if (!stories.length) return [];
      return this.db.taigaCard.findMany({ where: { taigaStoryId: { in: stories.map(({ id }) => id) } } });
    } catch (error) {
      this.log.warn({ feature: "taiga", epicId, errorType: errorType(error) }, "Listing epic user stories failed");
      return [];
    }
  }

  // ---------------------------------------------------------------- Reconcile

  /**
   * Repairs anything the webhook missed — a delivery lost while the bot was
   * restarting, or a failed handler. Safe to run on a timer.
   */
  async reconcile(): Promise<void> {
    const settings = await this.settings.get();
    if (!settings.enabled) return;

    const tracked = await this.db.taigaCard.findMany({ where: { declinedAt: null, deleting: false } });
    let remote: { id: number; statusName: string | null }[] | null = null;
    try {
      remote = await this.taiga.listUserStories();
    } catch (error) {
      this.log.warn({ feature: "taiga", errorType: errorType(error) }, "Reading the Taiga board failed; skipping deletion checks");
    }

    const actions = reconcileCards(
      tracked.map(({ taigaStoryId, statusName, declinedAt }) => ({ taigaStoryId, statusName, declinedAt })),
      remote ?? [],
      { remoteComplete: remote !== null },
    );
    for (const action of actions) {
      const card = tracked.find((item) => item.taigaStoryId === action.taigaStoryId);
      if (!card) continue;
      try {
        if (action.type === "moved") await this.applyColumnChange(card, action.to);
        else await this.handleCardDeleted(card);
      } catch (error) {
        this.log.error({ feature: "taiga", taigaRef: card.taigaRef, action: action.type, errorType: errorType(error) }, "Taiga reconcile action failed");
      }
    }
    if (actions.length) this.log.info({ feature: "taiga", repairedCount: actions.length }, "Taiga reconcile repaired card state");

    await this.reconcileEpics(settings.epicsSeededAt !== null);
  }

  private async reconcileEpics(seeded: boolean): Promise<void> {
    let epics: TaigaEpic[];
    try {
      epics = await this.taiga.listEpics();
    } catch (error) {
      this.log.warn({ feature: "taiga", errorType: errorType(error) }, "Reading Taiga epics failed");
      return;
    }
    for (const epic of epics) {
      // The first sweep after enabling records what already exists without
      // announcing it, so switching the feature on is never a burst of embeds.
      await this.recordEpic(epic, { announce: seeded });
    }
    // Only prune against a non-empty list: an empty result would otherwise wipe
    // every record, and the next sweep would re-announce them all as new.
    const ids = epics.map(({ id }) => id);
    if (ids.length) await this.db.taigaEpicState.deleteMany({ where: { taigaEpicId: { notIn: ids } } });
    if (!seeded) await this.settings.markEpicsSeeded();
  }

  // ---------------------------------------------------------------- Helpers

  private kindForChannel(parentId: string | null, bugForumId: string, suggestionForumId: string): TaigaCardKind | null {
    if (!parentId) return null;
    if (bugForumId && parentId === bugForumId) return "BUG";
    if (suggestionForumId && parentId === suggestionForumId) return "SUGGESTION";
    return null;
  }

  private async statusIdFor(columnName: string): Promise<number | undefined> {
    try {
      const statuses = await this.taiga.statuses();
      const match = statuses.find((status) => sameName(status.name, columnName));
      if (!match) {
        this.log.warn({ feature: "taiga", column: columnName }, "Taiga board has no column with this name");
        return undefined;
      }
      return match.id;
    } catch (error) {
      this.log.warn({ feature: "taiga", column: columnName, errorType: errorType(error) }, "Reading Taiga statuses failed");
      return undefined;
    }
  }

  private async applyColumnToPost(card: TaigaCard, column: string): Promise<void> {
    const tags = tagsForColumn(column);
    if (!tags) {
      this.log.warn({ feature: "taiga", column, taigaRef: card.taigaRef }, "Unknown Taiga column; leaving the post's tags alone");
      return;
    }
    await this.applyPostState(card, tags, shouldArchiveForColumn(column));
  }

  private async applyPostState(card: TaigaCard, tags: string[], archived: boolean): Promise<void> {
    try {
      const forum = await fetchForumChannel(this.client, card.channelId);
      const thread = await this.client.channels.fetch(card.threadId).catch(() => null);
      if (!forum || !thread || thread.type !== ChannelType.PublicThread) {
        this.log.warn({ feature: "taiga", threadId: card.threadId }, "Forum post is no longer reachable; skipping tag update");
        return;
      }
      const { missing } = await applyForumState(thread, forum, { tags, archived });
      if (missing.length) this.log.warn({ feature: "taiga", channelId: card.channelId, missingTags: missing }, "Forum is missing tags the board maps to");
    } catch (error) {
      this.log.error({ feature: "taiga", threadId: card.threadId, errorType: errorType(error) }, "Updating the forum post failed");
    }
  }

  /** Configuration health for the /taiga panel: names that do not resolve. */
  async health(): Promise<HealthReport> {
    const settings = await this.settings.get();
    const problems: string[] = [];
    const missingColumns: string[] = [];
    const missingTags = new Set<string>();

    const trackedCards = await this.db.taigaCard.count({ where: { declinedAt: null } });
    try {
      const statuses = await this.taiga.statuses(true);
      for (const column of KNOWN_COLUMNS) {
        if (!statuses.some((status) => sameName(status.name, column))) missingColumns.push(column);
      }
    } catch (error) {
      problems.push(`Taiga API unreachable (${errorType(error)})`);
    }

    for (const channelId of [settings.bugForumChannelId, settings.suggestionForumChannelId]) {
      if (!channelId) continue;
      const forum = await fetchForumChannel(this.client, channelId).catch(() => null);
      if (!forum) {
        problems.push(`<#${channelId}> is not a reachable forum channel`);
        continue;
      }
      for (const name of resolveTagIds(forum, KNOWN_FORUM_TAGS).missing) missingTags.add(name);
    }
    if (!isKnownColumn(INITIAL_COLUMN)) problems.push("The initial column is not part of the tag mapping");

    return {
      enabled: settings.enabled,
      trackedCards,
      missingColumns,
      missingTags: [...missingTags],
      problems,
    };
  }

  /** Removes webhook idempotency keys past their retention window. */
  async cleanupDeliveries(retentionDays: number, now = new Date()): Promise<number> {
    const receivedBefore = new Date(now.getTime() - retentionDays * 86_400_000);
    const result = await this.db.taigaWebhookDelivery.deleteMany({ where: { receivedAt: { lt: receivedBefore } } });
    return result.count;
  }
}
