import { Prisma, type TaigaCard, type TaigaCardKind } from "@prisma/client";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import { TaigaApiError, type TaigaClient, type TaigaEpic } from "../client.js";
import {
  DECLINED_TAGS, INITIAL_COLUMN, KNOWN_COLUMNS, isKnownColumn, isShippedColumn,
  sameName, shouldArchiveForColumn, tagsForColumn,
} from "../domain/mapping.js";
import { reconcileCards } from "../domain/reconcile.js";
import { buildStoryDescription, buildStorySubject } from "../domain/story.js";
import { currentColumn, type TaigaWebhookPayload } from "../domain/webhook.js";
import type { ForumPostMeta, TaigaBotPort, TaigaNotice } from "../link.js";
import type { TaigaSettingsService } from "./settings.js";

/** The board's side of the configuration health check. The forums are checked where Discord is. */
export type HealthReport = {
  enabled: boolean;
  trackedCards: number;
  missingColumns: string[];
  problems: string[];
};

/**
 * Two-way sync between the forums and the board. Taiga, the card rows and
 * every decision are here; Discord is reached through the bot half, which
 * reads posts, retags them and posts the notifications.
 *
 * When the bot cannot be reached, a board change is not recorded as applied:
 * the row keeps its old state, so the reconcile sweep that runs once the
 * gateway is back sees the difference and repairs the post.
 */
export class TaigaSyncService {
  private readonly log: Logger;

  constructor(
    private readonly db: Db,
    private readonly taiga: TaigaClient,
    private readonly settings: TaigaSettingsService,
    private readonly discord: TaigaBotPort,
    log: Logger,
  ) {
    this.log = log.child({ category: "taiga" });
  }

  /** Narrates a change in the notifications channel. Never throws into the sync path. */
  private async notify(notice: TaigaNotice): Promise<void> {
    try {
      const { notificationChannelId } = await this.settings.get();
      if (!notificationChannelId) return;
      await this.discord.notify(notificationChannelId, notice);
    } catch (error) {
      if (error instanceof LinkUnavailableError) {
        this.log.debug({ notice: notice.type, reason: error.message }, "Discord is not reachable; a board notification was skipped");
        return;
      }
      this.log.warn({ err: error, errorType: errorType(error) }, "Could not post to the notifications channel");
    }
  }

  // ---------------------------------------------------------------- Discord → Taiga

  /**
   * A new forum post becomes a card in the first column. Posts that predate the
   * integration being switched on are ignored, so enabling it never back-fills
   * the existing forums.
   */
  async handleThreadCreated(post: ForumPostMeta): Promise<void> {
    const settings = await this.settings.get();
    if (!settings.enabled || !settings.activatedAt) return;
    const kind = this.kindForChannel(post.parentId, settings.bugForumChannelId, settings.suggestionForumChannelId);
    if (!kind) return;
    const createdAt = post.createdAt ?? new Date();
    if (createdAt < settings.activatedAt) return;

    const existing = await this.db.taigaCard.findUnique({ where: { threadId: post.threadId } });
    if (existing) return;

    // Only now is the post worth reading: it is in a tracked forum and new.
    const { starter, author } = await this.discord.readForumPost(post.threadId);
    if (!author) {
      this.log.warn({ threadId: post.threadId }, "Forum post has no resolvable author; skipping card creation");
      return;
    }
    if (starter && !starter.content) {
      // Empty content on a real message means the privileged MessageContent
      // intent is missing or the post genuinely had only attachments.
      this.log.warn({ threadId: post.threadId }, "Forum post starter message had no readable content");
    }

    const statusId = await this.statusIdFor(INITIAL_COLUMN);
    const story = await this.taiga.createUserStory({
      subject: buildStorySubject(post.name),
      description: buildStoryDescription({
        body: starter?.content ?? "",
        guildId: post.guildId,
        threadId: post.threadId,
        author: { discordId: author.id, name: author.name },
      }),
      ...(statusId === undefined ? {} : { statusId }),
      tags: [kind === "BUG" ? "bug" : "suggestion"],
    });

    const card = await this.db.taigaCard.create({
      data: {
        taigaStoryId: story.id,
        taigaRef: story.ref,
        guildId: post.guildId,
        channelId: post.parentId ?? "",
        threadId: post.threadId,
        kind,
        title: buildStorySubject(post.name),
        statusName: INITIAL_COLUMN,
        authorDiscordId: author.id,
        authorName: author.name,
      },
    });
    this.log.info({ actor: card.authorName, card: `#${story.ref}`, kind }, "Card created from a forum post");
    await this.applyColumnToPost(card, INITIAL_COLUMN).catch((error: unknown) => {
      // The card exists; the post's tags are repaired by the next change.
      this.log.warn({ err: error, errorType: errorType(error), card: `#${story.ref}` }, "Could not tag a new forum post");
    });
    await this.notify({ type: "cardCreated", card, storyUrl: this.taiga.storyUrl(card.taigaRef) });
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
        this.log.error({ err: error, errorType: errorType(error), threadId }, "Could not delete the card");
        await this.db.taigaCard.update({ where: { id: card.id }, data: { deleting: false } });
        return;
      }
    }
    await this.db.taigaCard.delete({ where: { id: card.id } });
    this.log.info({ actor: card.authorName, card: `#${card.taigaRef}` }, "Card removed with its forum post");
    await this.notify({ type: "postRemoved", card });
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
      this.log.info({ actor: card.authorName, card: `#${card.taigaRef}` }, "Shipped card cleared off the board");
      await this.notify({ type: "shippedCardRemoved", card });
      return;
    }
    const updated = await this.db.taigaCard.update({ where: { id: card.id }, data: { declinedAt: new Date() } });
    try {
      await this.applyPostState(updated, DECLINED_TAGS, true);
    } catch (error) {
      // Not declined until the post says so: the reconcile sweep will find the
      // card missing from the board again and finish the job.
      await this.db.taigaCard.update({ where: { id: card.id }, data: { declinedAt: null } });
      throw error;
    }
    this.log.info({ actor: card.authorName, card: `#${card.taigaRef}`, lastColumn: card.statusName }, "Card deleted; the post is now marked declined");
    await this.notify({ type: "cardDeclined", card: updated });
  }

  private async applyColumnChange(card: TaigaCard, column: string): Promise<void> {
    const from = card.statusName;
    const updated = await this.db.taigaCard.update({ where: { id: card.id }, data: { statusName: column } });
    try {
      await this.applyColumnToPost(updated, column);
    } catch (error) {
      // Not moved until the post says so: keep the old column, and the
      // reconcile sweep moves it again once Discord is back.
      await this.db.taigaCard.update({ where: { id: card.id }, data: { statusName: from } });
      throw error;
    }
    this.log.info({ actor: card.authorName, card: `#${card.taigaRef}` }, `Card moved from ${from} to ${column}`);
    await this.notify({ type: "cardMoved", card: updated, from, to: column, storyUrl: this.taiga.storyUrl(updated.taigaRef) });
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
    await this.notify({ type: "epic", epic, action, relatedCards: related, epicUrl: this.taiga.epicUrl(epic.ref) });
  }

  private async relatedCards(epicId: number): Promise<TaigaCard[]> {
    try {
      const stories = await this.taiga.epicUserStories(epicId);
      if (!stories.length) return [];
      return this.db.taigaCard.findMany({ where: { taigaStoryId: { in: stories.map(({ id }) => id) } } });
    } catch (error) {
      this.log.warn({ err: error, errorType: errorType(error), epicId }, "Could not list the stories of an epic");
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
      this.log.warn({ err: error, errorType: errorType(error) }, "Board unreachable; skipping deletion checks");
    }

    const actions = reconcileCards(
      tracked.map(({ taigaStoryId, statusName, declinedAt }) => ({ taigaStoryId, statusName, declinedAt })),
      remote ?? [],
      { remoteComplete: remote !== null },
    );
    let repaired = 0;
    for (const action of actions) {
      const card = tracked.find((item) => item.taigaStoryId === action.taigaStoryId);
      if (!card) continue;
      try {
        if (action.type === "moved") await this.applyColumnChange(card, action.to);
        else await this.handleCardDeleted(card);
        repaired += 1;
      } catch (error) {
        // Every remaining step needs Discord too; the next sweep after the
        // gateway is back picks them all up.
        if (error instanceof LinkUnavailableError) {
          this.log.debug({ pending: actions.length - repaired }, "Discord is not reachable; reconcile will finish once it is");
          break;
        }
        this.log.error({ err: error, errorType: errorType(error), card: `#${card.taigaRef}`, action: action.type }, "Reconcile step failed");
      }
    }
    if (repaired) this.log.info({ repaired }, "Reconcile repaired card state");

    await this.reconcileEpics(settings.epicsSeededAt !== null);
  }

  private async reconcileEpics(seeded: boolean): Promise<void> {
    let epics: TaigaEpic[];
    try {
      epics = await this.taiga.listEpics();
    } catch (error) {
      this.log.warn({ err: error, errorType: errorType(error) }, "Could not read the epics");
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
        this.log.warn({ column: columnName }, "The board has no column with this name");
        return undefined;
      }
      return match.id;
    } catch (error) {
      this.log.warn({ err: error, errorType: errorType(error), column: columnName }, "Could not read the board statuses");
      return undefined;
    }
  }

  private async applyColumnToPost(card: TaigaCard, column: string): Promise<void> {
    const tags = tagsForColumn(column);
    if (!tags) {
      this.log.warn({ card: `#${card.taigaRef}`, column }, "Unknown column; leaving the post's tags alone");
      return;
    }
    await this.applyPostState(card, tags, shouldArchiveForColumn(column));
  }

  /**
   * Has the bot retag the post. Discord's own failures are logged there and
   * never undo a card; only the bot being unreachable is passed on, so the
   * caller can leave the row as it was for the reconcile sweep.
   */
  private async applyPostState(card: TaigaCard, tags: string[], archived: boolean): Promise<void> {
    try {
      await this.discord.applyPostState(
        { channelId: card.channelId, threadId: card.threadId, taigaRef: card.taigaRef },
        { tags, archived },
      );
    } catch (error) {
      if (error instanceof LinkUnavailableError) throw error;
      this.log.error({ threadId: card.threadId, err: error, errorType: errorType(error) }, "Updating the forum post failed");
    }
  }

  /** Configuration health for the `/config` page: board names that do not resolve. */
  async health(): Promise<HealthReport> {
    const settings = await this.settings.get();
    const problems: string[] = [];
    const missingColumns: string[] = [];

    const trackedCards = await this.db.taigaCard.count({ where: { declinedAt: null } });
    try {
      const statuses = await this.taiga.statuses(true);
      for (const column of KNOWN_COLUMNS) {
        if (!statuses.some((status) => sameName(status.name, column))) missingColumns.push(column);
      }
    } catch (error) {
      problems.push(`Taiga API unreachable (${errorType(error)})`);
    }
    if (!isKnownColumn(INITIAL_COLUMN)) problems.push("The initial column is not part of the tag mapping");

    return { enabled: settings.enabled, trackedCards, missingColumns, problems };
  }

  /** Removes webhook idempotency keys past their retention window. */
  async cleanupDeliveries(retentionDays: number, now = new Date()): Promise<number> {
    const receivedBefore = new Date(now.getTime() - retentionDays * 86_400_000);
    const result = await this.db.taigaWebhookDelivery.deleteMany({ where: { receivedAt: { lt: receivedBefore } } });
    return result.count;
  }
}
