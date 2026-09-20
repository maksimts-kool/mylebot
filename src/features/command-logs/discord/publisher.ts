import {
  ChannelType, Client, DiscordAPIError, ThreadAutoArchiveDuration,
  type AnyThreadChannel, type Message, type TextChannel,
} from "discord.js";
import type { CommandLogEntry, CommandLogThread } from "@prisma/client";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import type { ServerRoster } from "../domain/roster.js";
import type { CommandLogService } from "../service/command-log-service.js";
import type { CommandLogSettingsService } from "../service/settings.js";
import { commandLogEmbed } from "./command-log-embed.js";
import { serverPanelComponents, serverPanelEmbed, threadName } from "./server-panel.js";

/** Discord API error codes this publisher has to tell apart. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/**
 * Owns what this feature looks like in Discord: a panel per running server in
 * the log channel, the thread of command records hanging off it, and the short
 * notices that say when somebody's access was moved.
 *
 * The panel is a projection of a live server, so it is rebuilt from the
 * database every time rather than kept in memory: any of the roster, a block,
 * or a press can change it, and the last write should win.
 */
export class CommandLogPublisher {
  private readonly log: Logger;
  /**
   * One server at a time. Rosters arrive on a timer while commands arrive
   * whenever staff type, and two of them together used to both find "no panel
   * yet" and create one, leaving a stray thread beside the one that won.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

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

  /** Runs `work` with nothing else touching the same server's panel. */
  private async serialised<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(jobId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.inFlight.set(jobId, next.catch(() => undefined));
    try {
      return await next;
    } finally {
      if (this.inFlight.get(jobId) === next) this.inFlight.delete(jobId);
    }
  }

  private async logChannel(): Promise<TextChannel | null> {
    const { channelId } = await this.settings.get();
    if (!channelId) return null;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      this.log.error({ channelId }, "The command log channel is not a text channel");
      return null;
    }
    return channel as TextChannel;
  }

  /** The panel's current look, built from the server row and the live blocks. */
  private async render(server: CommandLogThread) {
    const staff = this.service.staffOf(server);
    const blockedUntil = await this.service.blockedUntil(staff.map((member) => BigInt(member.userId)));
    return {
      embeds: [serverPanelEmbed(server, staff, blockedUntil)],
      components: serverPanelComponents(server, staff, blockedUntil),
    };
  }

  /**
   * Opens a server's panel and the thread that hangs off it. The thread is
   * started *from* the panel message, so Discord shows the log directly under
   * the server it belongs to instead of somewhere else in the channel.
   */
  private async open(roster: ServerRoster, now: Date): Promise<CommandLogThread | null> {
    const channel = await this.logChannel();
    if (!channel) return null;

    const draft: CommandLogThread = {
      jobId: roster.jobId,
      channelId: channel.id,
      threadId: "",
      panelMessageId: null,
      placeId: roster.placeId,
      serverType: roster.serverType,
      playerCount: roster.playerCount,
      maxPlayers: roster.maxPlayers,
      staff: [],
      lastSeenAt: now,
      closedAt: null,
      createdAt: now,
      lastPostedAt: now,
    };
    const message = await channel.send(await this.render(draft));
    const thread = await message.startThread({
      name: threadName(roster),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Adonis command log for job ${roster.jobId}`,
    });
    this.log.info({ jobId: roster.jobId }, "Opened a panel and log thread for a server");
    return this.db.commandLogThread.create({
      data: {
        jobId: roster.jobId,
        channelId: channel.id,
        threadId: thread.id,
        panelMessageId: message.id,
        placeId: roster.placeId,
        serverType: roster.serverType,
        playerCount: roster.playerCount,
        maxPlayers: roster.maxPlayers,
        staff: [],
        lastSeenAt: now,
      },
    });
  }

  /** Edits a server's panel to match its row, reposting one that is gone. */
  private async repaint(server: CommandLogThread): Promise<void> {
    const channel = await this.logChannel();
    if (!channel || channel.id !== server.channelId) return;
    const view = await this.render(server);
    if (server.panelMessageId) {
      try {
        await channel.messages.edit(server.panelMessageId, view);
        return;
      } catch (error) {
        const code = error instanceof DiscordAPIError ? error.code : null;
        if (code !== UNKNOWN_MESSAGE && code !== UNKNOWN_CHANNEL) throw error;
        // Deleting the panel deletes its thread with it, so there is nothing
        // to hang a replacement off and no records left to keep.
        this.log.warn({ jobId: server.jobId }, "A server panel is gone; it will not be reposted");
        await this.db.commandLogThread.delete({ where: { jobId: server.jobId } }).catch(() => undefined);
      }
    }
  }

  /**
   * What a server reported about itself. The first report opens its panel; the
   * rest keep it honest, including the last one, which closes it.
   */
  async syncServer(roster: ServerRoster): Promise<void> {
    await this.serialised(roster.jobId, async () => {
      if (!this.client.isReady()) return;
      const existing = await this.service.server(roster.jobId);
      // A server that closed stays closed: a late report must not reopen it.
      if (existing?.closedAt) return;
      const server = existing ?? await this.open(roster, new Date());
      if (!server) return;
      await this.repaint(await this.service.saveRoster(roster));
    }).catch((error: unknown) => {
      this.log.error({ err: error, errorType: errorType(error), jobId: roster.jobId }, "Updating a server panel failed");
    });
  }

  /** Re-renders panels the sweep closed, so they stop offering a dead server. */
  async closeServers(servers: CommandLogThread[]): Promise<void> {
    for (const server of servers) {
      await this.serialised(server.jobId, () => this.repaint(server)).catch((error: unknown) => {
        this.log.error({ err: error, errorType: errorType(error), jobId: server.jobId }, "Closing a server panel failed");
      });
    }
  }

  /** Re-renders one server's panel after a block was applied or lifted. */
  async refreshPanel(jobId: string): Promise<void> {
    await this.serialised(jobId, async () => {
      const server = await this.service.server(jobId);
      if (server) await this.repaint(server);
    }).catch((error: unknown) => {
      this.log.error({ err: error, errorType: errorType(error), jobId }, "Refreshing a server panel failed");
    });
  }

  private async thread(server: CommandLogThread): Promise<AnyThreadChannel | null> {
    try {
      const thread = await this.client.channels.fetch(server.threadId) as AnyThreadChannel;
      if (thread.archived) await thread.setArchived(false);
      return thread;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === UNKNOWN_CHANNEL) {
        this.log.warn({ jobId: server.jobId }, "A command log thread is gone");
        return null;
      }
      throw error;
    }
  }

  /**
   * Posts one command run into its server's thread. A run can reach us before
   * the server's first roster does, so the panel is opened here too when it
   * has to be.
   */
  async post(entry: CommandLogEntry): Promise<void> {
    if (!this.client.isReady()) {
      this.log.warn({ jobId: entry.jobId }, "Discord is not connected; a command run went unposted");
      return;
    }
    const server = await this.serialised(entry.jobId, async () => {
      const existing = await this.service.server(entry.jobId);
      if (existing) return existing;
      return this.open({
        universeId: 0n,
        placeId: entry.placeId,
        jobId: entry.jobId,
        serverType: entry.serverType,
        playerCount: entry.playerCount,
        maxPlayers: entry.maxPlayers,
        closed: false,
        staff: [],
      }, entry.occurredAt);
    });
    if (!server) return;

    const thread = await this.thread(server);
    if (!thread) return;
    const message = await thread.send({
      embeds: [commandLogEmbed(entry, { discordUserId: await this.bloxlink.discordForRoblox(entry.robloxUserId) })],
    });
    await this.service.recordMessage(entry.id, thread.id, message.id);
    await this.db.commandLogThread.update({
      where: { jobId: entry.jobId },
      data: { lastPostedAt: new Date() },
    }).catch(() => undefined);
  }

  async postMany(entries: CommandLogEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.post(entry).catch((error: unknown) => {
        this.log.error({ err: error, errorType: errorType(error), entryId: entry.id }, "Posting a command run failed");
      });
    }
  }

  /**
   * Leaves a line in the server's thread saying somebody's access moved. The
   * panel shows the current state; the thread is where it is remembered.
   */
  async notice(jobId: string, content: string): Promise<Message | null> {
    const server = await this.service.server(jobId);
    if (!server) return null;
    const thread = await this.thread(server);
    if (!thread) return null;
    return thread.send({ content, allowedMentions: { parse: [] } });
  }
}
