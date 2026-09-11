import { Events, type Client } from "discord.js";
import { errorType } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { TaigaSyncService } from "../service/taiga-sync.js";

/**
 * Watches the two forums. Only posts created from now on are picked up —
 * `newlyCreated` is false when Discord replays a thread the bot merely gained
 * access to, and the sync service additionally ignores anything older than the
 * activation stamp.
 */
export function registerForumListener(client: Client, sync: TaigaSyncService, parentLog: Logger): void {
  const log = parentLog.child({ category: "taiga" });
  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    if (!newlyCreated) return;
    void sync.handleThreadCreated(thread).catch((error: unknown) => {
      log.error({ err: error, errorType: errorType(error), threadId: thread.id }, "Could not create a card for a new forum post");
    });
  });

  client.on(Events.ThreadDelete, (thread) => {
    void sync.handleThreadDeleted(thread.id).catch((error: unknown) => {
      log.error({ err: error, errorType: errorType(error), threadId: thread.id }, "Could not remove the card for a deleted forum post");
    });
  });
}
