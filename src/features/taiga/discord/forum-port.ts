import { ChannelType, type Client } from "discord.js";
import { errorType } from "../../../core/errors.js";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import type { TaigaBotPort } from "../link.js";
import { postNotice } from "./notifications.js";
import { applyForumState, fetchForumChannel } from "./tags.js";

/** The Taiga integration's hands in Discord: reading posts, retagging them, and the notifications channel. */
export function taigaBotPort(client: Client, parentLog: Logger): TaigaBotPort {
  const log = parentLog.child({ category: "taiga" });

  function requireReady(): void {
    if (!client.isReady()) throw new LinkUnavailableError("Discord is not connected");
  }

  return {
    async readForumPost(threadId) {
      requireReady();
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread?.isThread()) return { starter: null, author: null };
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const author = starter?.author ?? (thread.ownerId ? await client.users.fetch(thread.ownerId).catch(() => null) : null);
      return {
        starter: starter ? { content: starter.content } : null,
        author: author ? { id: author.id, name: author.displayName || author.username } : null,
      };
    },

    async applyPostState(card, state) {
      requireReady();
      try {
        const forum = await fetchForumChannel(client, card.channelId);
        const thread = await client.channels.fetch(card.threadId).catch(() => null);
        if (!forum || !thread || thread.type !== ChannelType.PublicThread) {
          log.warn({ threadId: card.threadId }, "Forum post is no longer reachable; skipping tag update");
          return;
        }
        const { missing } = await applyForumState(thread, forum, state);
        if (missing.length) log.warn({ channelId: card.channelId, missingTags: missing }, "Forum is missing tags the board maps to");
      } catch (error) {
        log.error({ threadId: card.threadId, err: error, errorType: errorType(error) }, "Updating the forum post failed");
      }
    },

    async notify(channelId, notice) {
      requireReady();
      await postNotice(client, channelId, notice);
    },
  };
}
