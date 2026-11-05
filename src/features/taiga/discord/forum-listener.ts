import { ChannelType, Events, type Client } from "discord.js";
import { errorType } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { TaigaServerPort } from "../link.js";

/**
 * Watches the forums. Only posts created from now on are passed on —
 * `newlyCreated` is false when Discord replays a thread the bot merely gained
 * access to — and the server half additionally ignores anything outside the
 * two tracked forums or older than the activation stamp.
 */
export function registerForumListener(client: Client, taiga: Pick<TaigaServerPort, "threadCreated" | "threadDeleted">, parentLog: Logger): void {
  const log = parentLog.child({ category: "taiga" });
  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    // Only forum posts can become cards; ordinary threads are not worth a call.
    if (!newlyCreated || (thread.parent && thread.parent.type !== ChannelType.GuildForum)) return;
    void taiga.threadCreated({
      threadId: thread.id,
      parentId: thread.parentId,
      guildId: thread.guildId,
      name: thread.name,
      createdAt: thread.createdAt,
    }).catch((error: unknown) => {
      log.error({ err: error, errorType: errorType(error), threadId: thread.id }, "Could not create a card for a new forum post");
    });
  });

  client.on(Events.ThreadDelete, (thread) => {
    void taiga.threadDeleted(thread.id).catch((error: unknown) => {
      log.error({ err: error, errorType: errorType(error), threadId: thread.id }, "Could not remove the card for a deleted forum post");
    });
  });
}
