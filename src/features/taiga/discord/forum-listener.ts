import { Events, type Client } from "discord.js";
import type { FastifyBaseLogger } from "fastify";
import { errorType } from "../../../core/errors.js";
import type { TaigaSyncService } from "../service/taiga-sync.js";

/**
 * Watches the two forums. Only posts created from now on are picked up —
 * `newlyCreated` is false when Discord replays a thread the bot merely gained
 * access to, and the sync service additionally ignores anything older than the
 * activation stamp.
 */
export function registerForumListener(client: Client, sync: TaigaSyncService, log: FastifyBaseLogger): void {
  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    if (!newlyCreated) return;
    void sync.handleThreadCreated(thread).catch((error: unknown) => {
      log.error({ feature: "taiga", threadId: thread.id, errorType: errorType(error) }, "Creating a Taiga card for a new post failed");
    });
  });

  client.on(Events.ThreadDelete, (thread) => {
    void sync.handleThreadDeleted(thread.id).catch((error: unknown) => {
      log.error({ feature: "taiga", threadId: thread.id, errorType: errorType(error) }, "Removing the Taiga card for a deleted post failed");
    });
  });
}
