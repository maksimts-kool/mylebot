import {
  ChannelType, Client, DiscordAPIError, EmbedBuilder, ThreadAutoArchiveDuration,
  type AnyThreadChannel, type TextChannel,
} from "discord.js";
import type { CommandLogEntry } from "@prisma/client";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import type { CommandLogService } from "../service/command-log-service.js";
import type { CommandLogSettingsService } from "../service/settings.js";
import { commandLogComponents, commandLogEmbed } from "./command-log-embed.js";

/** What a press did to the runner's access, for re-rendering their message. */
export type AccessChange =
  | { blockedUntil: Date; blockedBy: string }
  | { blockedUntil: null; restoredBy: string };

/** Discord API error codes this publisher has to tell apart. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/** A job id is 36 characters; a thread name has room for it and a word. */
function threadName(entry: CommandLogEntry): string {
  const label = entry.serverType === "STUDIO" ? "Studio" : "Server";
  return `${label} ${entry.jobId}`.slice(0, 100);
}

/**
 * The first message in a new thread: which server this is, so the thread is
 * self-explanatory even after the server it belongs to is long gone.
 */
function threadHeader(entry: CommandLogEntry): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(entry.serverType === "STUDIO" ? "🧪 Studio playtest" : "🌐 Public server")
    .setDescription(`Commands run in this server are logged here.\nJob ID \`${entry.jobId}\` · place \`${entry.placeId}\``)
    .setColor(BRAND_COLOR)
    .setTimestamp(entry.occurredAt);
}

/**
 * Posts command runs into one thread per Roblox server. The channel would be
 * unreadable otherwise: a busy server produces a run every few seconds, and a
 * reader almost always wants one server's story rather than all of them
 * interleaved.
 */
export class CommandLogPublisher {
  private readonly log: Logger;
  /**
   * One thread lookup per server at a time. Two commands arriving together used
   * to both find "no thread yet" and create one, leaving a stray empty thread
   * next to the one that won.
   */
  private readonly inFlight = new Map<string, Promise<AnyThreadChannel | null>>();

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly bloxlink: BloxlinkService,
    private readonly settings: CommandLogSettingsService,
    private readonly service: CommandLogService,
    log: Logger,
  ) {
    this.log = log.child({ category: "command" });
  }

  private async createThread(entry: CommandLogEntry, channelId: string): Promise<AnyThreadChannel | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      this.log.error({ channelId }, "The command log channel is not a text channel");
      return null;
    }
    const thread = await (channel as TextChannel).threads.create({
      name: threadName(entry),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      type: ChannelType.PublicThread,
      reason: `Adonis command log for job ${entry.jobId}`,
    });
    await thread.send({ embeds: [threadHeader(entry)] });
    await this.db.commandLogThread.create({
      data: { jobId: entry.jobId, channelId, threadId: thread.id, placeId: entry.placeId },
    });
    this.log.info({ jobId: entry.jobId }, "Opened a command log thread for a server");
    return thread;
  }

  /**
   * The thread this server's commands belong in, creating it the first time and
   * reopening it when Discord has archived it. A thread somebody deleted is
   * forgotten and made again, so a deleted thread cannot stop the logging.
   */
  private async resolveThread(entry: CommandLogEntry, channelId: string): Promise<AnyThreadChannel | null> {
    const saved = await this.db.commandLogThread.findUnique({ where: { jobId: entry.jobId } });
    // A channel change in `/config` must not keep posting into the old channel.
    if (saved && saved.channelId === channelId) {
      try {
        const thread = await this.client.channels.fetch(saved.threadId) as AnyThreadChannel;
        if (thread.archived) await thread.setArchived(false);
        return thread;
      } catch (error) {
        if (!(error instanceof DiscordAPIError) || error.code !== UNKNOWN_CHANNEL) throw error;
        this.log.warn({ jobId: entry.jobId }, "The command log thread is gone; opening a new one");
      }
    }
    if (saved) await this.db.commandLogThread.delete({ where: { jobId: entry.jobId } });
    return this.createThread(entry, channelId);
  }

  private async thread(entry: CommandLogEntry, channelId: string): Promise<AnyThreadChannel | null> {
    const pending = this.inFlight.get(entry.jobId);
    if (pending) return pending;
    const work = this.resolveThread(entry, channelId).finally(() => this.inFlight.delete(entry.jobId));
    this.inFlight.set(entry.jobId, work);
    return work;
  }

  /** Posts one command run. A failure here must not fail the ingestion call. */
  async post(entry: CommandLogEntry): Promise<void> {
    if (!this.client.isReady()) {
      this.log.warn({ jobId: entry.jobId }, "Discord is not connected; a command run went unposted");
      return;
    }
    const { channelId } = await this.settings.get();
    if (!channelId) return;
    const thread = await this.thread(entry, channelId);
    if (!thread) return;
    const block = await this.service.activeBlock(entry.robloxUserId);
    const view = {
      discordUserId: await this.bloxlink.discordForRoblox(entry.robloxUserId),
      blockedUntil: block?.expiresAt ?? null,
      blockedBy: block ? `<@${block.byDiscordUserId}>` : null,
    };
    const message = await thread.send({
      embeds: [commandLogEmbed(entry, view)],
      components: commandLogComponents(entry, view),
    });
    await this.service.recordMessage(entry.id, thread.id, message.id);
    await this.db.commandLogThread.update({
      where: { jobId: entry.jobId },
      data: { lastPostedAt: new Date() },
    });
  }

  async postMany(entries: CommandLogEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.post(entry).catch((error: unknown) => {
        this.log.error({ err: error, errorType: errorType(error), entryId: entry.id }, "Posting a command run failed");
      });
    }
  }

  /**
   * Re-renders an entry's own message after its access was taken away or given
   * back, so the record shows what happened and the message only ever offers
   * the press that makes sense next.
   */
  async refresh(entry: CommandLogEntry, access: AccessChange): Promise<void> {
    if (!entry.threadId || !entry.messageId) return;
    const view = { discordUserId: await this.bloxlink.discordForRoblox(entry.robloxUserId), ...access };
    try {
      const thread = await this.client.channels.fetch(entry.threadId) as AnyThreadChannel;
      if (thread.archived) await thread.setArchived(false);
      await thread.messages.edit(entry.messageId, {
        embeds: [commandLogEmbed(entry, view)],
        components: commandLogComponents(entry, view),
      });
    } catch (error) {
      const code = error instanceof DiscordAPIError ? error.code : null;
      if (code === UNKNOWN_MESSAGE || code === UNKNOWN_CHANNEL) return;
      this.log.error({ err: error, errorType: errorType(error), entryId: entry.id }, "Updating a command run failed");
    }
  }
}
