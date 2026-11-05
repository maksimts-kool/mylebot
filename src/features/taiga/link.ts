import type { TaigaCard } from "@prisma/client";
import type { TaigaSettings } from "./service/settings.js";

/**
 * The contract between the two halves of the Taiga integration. The server
 * half talks to Taiga, keeps the card rows and decides every post's board
 * state; the bot half reads new forum posts, retags them and narrates the
 * board in the notifications channel.
 */

export const TAIGA_PORT = "taiga";

/** What a notification or a retag needs to know about a card. */
export type CardView = Pick<TaigaCard, "kind" | "title" | "statusName" | "authorDiscordId" | "guildId" | "channelId" | "threadId" | "taigaRef">;

export type EpicView = { id: number; ref: number; subject: string; statusName: string | null; isClosed: boolean };

/** One line in the notifications channel. Links are built by the server half, which knows the board. */
export type TaigaNotice =
  | { type: "cardCreated"; card: CardView; storyUrl: string }
  | { type: "cardMoved"; card: CardView; from: string; to: string; storyUrl: string }
  | { type: "cardDeclined"; card: CardView }
  | { type: "postRemoved"; card: CardView }
  | { type: "shippedCardRemoved"; card: CardView }
  | { type: "epic"; epic: EpicView; action: "created" | "updated" | "closed"; relatedCards: CardView[]; epicUrl: string };

export type ForumState = {
  /** Exact set of board-state tags the post should carry. */
  tags: string[];
  archived: boolean;
};

/** A forum post as the gateway announced it, before anything was fetched. */
export type ForumPostMeta = {
  threadId: string;
  parentId: string | null;
  guildId: string;
  name: string;
  createdAt: Date | null;
};

/** What a post says and who wrote it, read only once the server half wants it. */
export type ForumPostDetails = {
  /** The first message, or null when it could not be fetched. */
  starter: { content: string } | null;
  author: { id: string; name: string } | null;
};

/** What the server half asks of Discord for this feature. */
export interface TaigaBotPort {
  readForumPost(threadId: string): Promise<ForumPostDetails>;
  /**
   * Brings a post to the requested board state. A post that is gone, or a
   * forum missing tags, is logged on the bot's side and is not an error.
   */
  applyPostState(card: Pick<CardView, "channelId" | "threadId" | "taigaRef">, state: ForumState): Promise<void>;
  /** Posts one line to the notifications channel. Never throws for Discord's reasons. */
  notify(channelId: string, notice: TaigaNotice): Promise<void>;
}

/** The board's side of the `/config` health check; the forums' side is the bot's. */
export type TaigaOverview = {
  settings: TaigaSettings;
  projectSlug: string;
  trackedCards: number;
  missingColumns: string[];
  problems: string[];
};

export type TaigaChannelField = "bugForumChannelId" | "suggestionForumChannelId" | "notificationChannelId";

/** What the forum listener and the `/config` page ask of the server half. */
export interface TaigaServerPort {
  /** A forum post was just created. The server half decides whether it becomes a card. */
  threadCreated(post: ForumPostMeta): Promise<void>;
  threadDeleted(threadId: string): Promise<void>;
  overview(): Promise<TaigaOverview>;
  setChannel(field: TaigaChannelField, channelId: string): Promise<void>;
  /** Throws a user-facing reason when the integration cannot be switched on yet. */
  setEnabled(enabled: boolean): Promise<void>;
  reconcile(): Promise<void>;
}
