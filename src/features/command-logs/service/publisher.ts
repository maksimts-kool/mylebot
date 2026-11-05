import type { CommandLogEntry, CommandLogThread } from "@prisma/client";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { shiftStatusAt, shiftStatusFor } from "../../../shared/staff-activity.js";
import type { ServerRoster } from "../domain/roster.js";
import type { CommandLogsBotPort, PanelView } from "../link.js";
import type { CommandLogService } from "./command-log-service.js";
import type { CommandLogSettingsService } from "./settings.js";

/**
 * Decides what this feature looks like in Discord: a panel per running server
 * in the log channel, the thread of command records hanging off it, and the
 * short notices that say when somebody's access was moved. The bot half draws
 * and posts them; this keeps the rows that say where they are.
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
    private readonly db: Db,
    private readonly bloxlink: BloxlinkService,
    private readonly settings: CommandLogSettingsService,
    private readonly service: CommandLogService,
    private readonly discord: CommandLogsBotPort,
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

  /** Logs a failure, quietly when it is only Discord being away. */
  private failed(error: unknown, fields: Record<string, unknown>, message: string): void {
    if (error instanceof LinkUnavailableError) {
      this.log.debug({ ...fields, reason: error.message }, `${message}; Discord is not reachable`);
      return;
    }
    this.log.error({ err: error, errorType: errorType(error), ...fields }, message);
  }

  /**
   * The panel's current look, built from the server row, the live blocks, and
   * the shifts the session tracker has running for the people in it.
   */
  private async render(server: CommandLogThread): Promise<PanelView> {
    const staff = this.service.staffOf(server);
    const robloxUserIds = staff.map((member) => BigInt(member.userId));
    const [blockedUntil, shifts] = await Promise.all([
      this.service.blockedUntil(robloxUserIds),
      shiftStatusAt(this.db, robloxUserIds, server.lastSeenAt),
    ]);
    return { server, staff, blockedUntil, shifts };
  }

  /**
   * Opens a server's panel and the thread that hangs off it. The thread is
   * started *from* the panel message, so Discord shows the log directly under
   * the server it belongs to instead of somewhere else in the channel.
   */
  private async open(roster: ServerRoster, now: Date): Promise<CommandLogThread | null> {
    const { channelId } = await this.settings.get();
    if (!channelId) return null;

    const draft: CommandLogThread = {
      jobId: roster.jobId,
      channelId,
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
    const opened = await this.discord.openPanel(channelId, await this.render(draft));
    if (!opened) return null;
    return this.db.commandLogThread.create({
      data: {
        jobId: roster.jobId,
        channelId: opened.channelId,
        threadId: opened.threadId,
        panelMessageId: opened.messageId,
        placeId: roster.placeId,
        serverType: roster.serverType,
        playerCount: roster.playerCount,
        maxPlayers: roster.maxPlayers,
        staff: [],
        lastSeenAt: now,
      },
    });
  }

  /** Redraws a server's panel to match its row. */
  private async repaint(server: CommandLogThread): Promise<void> {
    const { channelId } = await this.settings.get();
    if (!channelId || channelId !== server.channelId || !server.panelMessageId) return;
    const result = await this.discord.editPanel(server.channelId, server.panelMessageId, await this.render(server));
    if (result === "edited") return;
    // Deleting the panel deletes its thread with it, so there is nothing to
    // hang a replacement off and no records left to keep.
    this.log.warn({ jobId: server.jobId }, "A server panel is gone; it will not be reposted");
    await this.db.commandLogThread.delete({ where: { jobId: server.jobId } }).catch(() => undefined);
  }

  /**
   * What a server reported about itself. Reports keep an open panel honest,
   * including the last one, which closes it. They never open one: that takes a
   * logged command run, in `post`.
   */
  async syncServer(roster: ServerRoster): Promise<void> {
    await this.serialised(roster.jobId, async () => {
      const existing = await this.service.server(roster.jobId);
      // A server that closed stays closed: a late report must not reopen it.
      if (!existing || existing.closedAt) return;
      await this.repaint(await this.service.saveRoster(roster));
    }).catch((error: unknown) => this.failed(error, { jobId: roster.jobId }, "Updating a server panel failed"));
  }

  /** Re-renders panels the sweep closed, so they stop offering a dead server. */
  async closeServers(servers: CommandLogThread[]): Promise<void> {
    for (const server of servers) {
      await this.serialised(server.jobId, () => this.repaint(server))
        .catch((error: unknown) => this.failed(error, { jobId: server.jobId }, "Closing a server panel failed"));
    }
  }

  /** Re-renders one server's panel after a block was applied or lifted. */
  async refreshPanel(jobId: string): Promise<void> {
    await this.serialised(jobId, async () => {
      const server = await this.service.server(jobId);
      if (server) await this.repaint(server);
    }).catch((error: unknown) => this.failed(error, { jobId }, "Refreshing a server panel failed"));
  }

  /** Takes a server's panel and thread out of the channel altogether, and forgets them. */
  async remove(server: CommandLogThread): Promise<void> {
    await this.serialised(server.jobId, async () => {
      await this.discord.removePanel({
        jobId: server.jobId, channelId: server.channelId, threadId: server.threadId, panelMessageId: server.panelMessageId,
      });
      await this.db.commandLogThread.delete({ where: { jobId: server.jobId } }).catch(() => undefined);
    });
  }

  /** Removes every panel no command was ever logged under. */
  async removeEmpty(retentionDays: number): Promise<number> {
    let removed = 0;
    for (const server of await this.service.emptyServers(retentionDays)) {
      try {
        await this.remove(server);
        removed += 1;
      } catch (error) {
        // Every remaining removal would fail the same way while Discord is away.
        if (error instanceof LinkUnavailableError) break;
        this.log.error({ err: error, errorType: errorType(error), jobId: server.jobId }, "Removing an empty server panel failed");
      }
    }
    return removed;
  }

  /**
   * Posts one command run into its server's thread. The first logged run in a
   * server is what opens its panel; rosters only keep one up to date.
   */
  async post(entry: CommandLogEntry): Promise<void> {
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

    const [discordUserId, shift] = await Promise.all([
      this.bloxlink.discordForRoblox(entry.robloxUserId),
      // Asked about the instant the command ran, not about now: a run that
      // reaches us late still belongs to whatever shift was open at the time.
      shiftStatusFor(this.db, entry.robloxUserId, entry.occurredAt),
    ]);
    const posted = await this.discord.postRun(server.threadId, entry, { discordUserId, shift });
    if (!posted) {
      this.log.warn({ jobId: server.jobId }, "A command log thread is gone");
      return;
    }
    await this.service.recordMessage(entry.id, server.threadId, posted.messageId);
    await this.db.commandLogThread.update({
      where: { jobId: entry.jobId },
      data: { lastPostedAt: new Date() },
    }).catch(() => undefined);
  }

  async postMany(entries: CommandLogEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        await this.post(entry);
      } catch (error) {
        // The run is stored either way; only its Discord copy is missing.
        if (error instanceof LinkUnavailableError) {
          this.log.warn({ jobId: entry.jobId, unposted: entries.length }, "Discord is not reachable; command runs went unposted");
          return;
        }
        this.log.error({ err: error, errorType: errorType(error), entryId: entry.id }, "Posting a command run failed");
      }
    }
  }

  /**
   * Leaves a line in the server's thread saying somebody's access moved. The
   * panel shows the current state; the thread is where it is remembered.
   */
  async notice(jobId: string, content: string): Promise<void> {
    const server = await this.service.server(jobId);
    if (!server) return;
    await this.discord.notice(server.threadId, content);
  }
}
