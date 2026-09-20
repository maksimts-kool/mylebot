import { Prisma, type CommandBlock, type CommandLogEntry, type CommandLogThread } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import type { Logger } from "../../../core/logger.js";
import { BLOCK_MINUTES, isQuietCommand } from "../domain/policy.js";
import type { CommandEvent } from "../domain/events.js";
import { readStoredStaff, toStoredStaff, type ServerRoster, type StoredStaff } from "../domain/roster.js";
import { riskForLevel } from "../domain/risk.js";
import type { CommandLogSettingsService } from "./settings.js";

/** Why an accepted event did not become a thread entry. */
export type SkipReason = "disabled" | "no_channel" | "studio_excluded" | "quiet_command";

export type RecordResult =
  | { status: "recorded"; entry: CommandLogEntry }
  | { status: "duplicate" }
  | { status: "skipped"; reason: SkipReason };

export type ActiveBlock = { robloxUserId: bigint; robloxUsername: string; expiresAt: Date };

export type BlockRequest = {
  robloxUserId: bigint;
  robloxUsername: string;
  byDiscordUserId: string;
  byDiscordName: string;
};

/**
 * Owns what the Roblox plugin reports and what Discord does with it: which runs
 * are worth keeping, the idempotency key that stops a retried batch posting
 * twice, and the temporary blocks the plugin polls for.
 */
export class CommandLogService {
  private readonly log: Logger;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: CommandLogSettingsService,
    log: Logger,
  ) {
    this.log = log.child({ category: "command" });
  }

  /**
   * Rejects an event that did not come from this universe, exactly as presence
   * ingestion does. A wrong universe or place means a misconfigured place or a
   * forged request, not a command worth logging.
   *
   * Age is deliberately not checked here, unlike presence: a stale heartbeat is
   * worthless, while a command run that reaches us late — after an outage, or
   * on the plugin's shutdown flush — is still exactly the record somebody will
   * want to read. The embed carries the instant it happened.
   */
  private assertSource(event: { universeId: bigint; placeId: bigint }): void {
    if (event.universeId !== this.config.ROBLOX_UNIVERSE_ID) {
      throw new Error(`Unexpected universe ${event.universeId}`);
    }
    if (!this.config.ROBLOX_ALLOWED_PLACE_IDS.includes(event.placeId)) {
      throw new Error(`Unexpected place ${event.placeId}`);
    }
  }

  async record(event: CommandEvent): Promise<RecordResult> {
    this.assertSource(event);

    const settings = await this.settings.get();
    if (!settings.enabled) return { status: "skipped", reason: "disabled" };
    if (!settings.channelId) return { status: "skipped", reason: "no_channel" };
    if (event.serverType === "STUDIO" && !settings.includeStudio) {
      return { status: "skipped", reason: "studio_excluded" };
    }
    if (isQuietCommand(event.command.name, event.command.alias)) return { status: "skipped", reason: "quiet_command" };

    try {
      const entry = await this.db.commandLogEntry.create({
        data: {
          eventId: event.eventId,
          jobId: event.jobId,
          placeId: event.placeId,
          robloxUserId: event.runner.userId,
          robloxUsername: event.runner.username,
          rankNumber: event.runner.rankNumber,
          rankName: event.runner.rankName,
          adminLevel: event.runner.adminLevel,
          requiredLevel: event.command.requiredLevel,
          commandText: event.command.text,
          commandName: event.command.name,
          commandAlias: event.command.alias,
          serverType: event.serverType,
          playerCount: event.playerCount,
          maxPlayers: event.maxPlayers,
          risk: riskForLevel(event.command.requiredLevel),
          targets: event.targets,
          occurredAt: new Date(event.occurredAt),
        },
      });
      return { status: "recorded", entry };
    } catch (error) {
      // The plugin re-sends a batch it never got a response for, so a repeated
      // event id is ordinary traffic rather than a failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { status: "duplicate" };
      }
      throw error;
    }
  }

  /**
   * Checks a roster the way a command run is checked, and answers whether this
   * server should be shown at all. The panel is the same projection as the log,
   * so it obeys the same switches.
   */
  async rosterAllowed(roster: ServerRoster): Promise<boolean> {
    this.assertSource(roster);
    const settings = await this.settings.get();
    if (!settings.enabled || !settings.channelId) return false;
    return roster.serverType !== "STUDIO" || settings.includeStudio;
  }

  async server(jobId: string): Promise<CommandLogThread | null> {
    return this.db.commandLogThread.findUnique({ where: { jobId } });
  }

  async serverByPanel(panelMessageId: string): Promise<CommandLogThread | null> {
    return this.db.commandLogThread.findFirst({ where: { panelMessageId } });
  }

  /** The staff a server last reported, read back out of its JSON column. */
  staffOf(server: CommandLogThread): StoredStaff[] {
    return readStoredStaff(server.staff);
  }

  /** Replaces a server's reported state with what the plugin just sent. */
  async saveRoster(roster: ServerRoster, now = new Date()): Promise<CommandLogThread> {
    return this.db.commandLogThread.update({
      where: { jobId: roster.jobId },
      data: {
        playerCount: roster.playerCount,
        maxPlayers: roster.maxPlayers,
        staff: toStoredStaff(roster.staff),
        lastSeenAt: now,
        closedAt: roster.closed ? now : null,
      },
    });
  }

  /**
   * Closes servers that stopped reporting. A server that shuts down says so,
   * but one that crashes or loses HTTP never does, and its panel would
   * otherwise keep offering to join a server that is not there.
   */
  async closeSilentServers(staleMs: number, now = new Date()): Promise<CommandLogThread[]> {
    const cutoff = new Date(now.getTime() - staleMs);
    const stale = await this.db.commandLogThread.findMany({
      where: { closedAt: null, lastSeenAt: { lt: cutoff } },
    });
    if (!stale.length) return [];
    await this.db.commandLogThread.updateMany({
      where: { jobId: { in: stale.map(({ jobId }) => jobId) } },
      data: { closedAt: now, staff: [] },
    });
    return stale.map((server) => ({ ...server, closedAt: now, staff: [] }));
  }

  /** When each of these people gets their commands back, keyed by Roblox ID. */
  async blockedUntil(robloxUserIds: bigint[], now = new Date()): Promise<Map<string, Date>> {
    if (!robloxUserIds.length) return new Map();
    const blocks = await this.db.commandBlock.findMany({
      where: { robloxUserId: { in: robloxUserIds }, expiresAt: { gt: now } },
      select: { robloxUserId: true, expiresAt: true },
    });
    return new Map(blocks.map((block) => [block.robloxUserId.toString(), block.expiresAt]));
  }

  async entry(id: string): Promise<CommandLogEntry | null> {
    return this.db.commandLogEntry.findUnique({ where: { id } });
  }

  /** Remembers where an entry was posted, so it can be edited later. */
  async recordMessage(id: string, threadId: string, messageId: string): Promise<void> {
    await this.db.commandLogEntry.update({ where: { id }, data: { threadId, messageId } });
  }

  /** The blocks the Roblox plugin enforces. Expired rows are never returned. */
  async activeBlocks(now = new Date()): Promise<ActiveBlock[]> {
    return this.db.commandBlock.findMany({
      where: { expiresAt: { gt: now } },
      select: { robloxUserId: true, robloxUsername: true, expiresAt: true },
      orderBy: { expiresAt: "asc" },
    });
  }

  /**
   * Takes command access away for `BLOCK_MINUTES`. A second press extends the
   * block rather than adding another, so one person can only be blocked once.
   */
  async block(request: BlockRequest, now = new Date()): Promise<Date> {
    const expiresAt = new Date(now.getTime() + BLOCK_MINUTES * 60 * 1000);
    await this.db.commandBlock.upsert({
      where: { robloxUserId: request.robloxUserId },
      create: { ...request, expiresAt },
      update: { ...request, expiresAt },
    });
    this.log.info(
      { actor: request.byDiscordName, target: request.robloxUsername, minutes: BLOCK_MINUTES },
      `Command access taken from ${request.robloxUsername}`,
    );
    return expiresAt;
  }

  /** The block in force for somebody, or null once it has run out. */
  async activeBlock(robloxUserId: bigint, now = new Date()): Promise<CommandBlock | null> {
    const block = await this.db.commandBlock.findUnique({ where: { robloxUserId } });
    return block && block.expiresAt > now ? block : null;
  }

  /**
   * Gives command access back before the fifteen minutes are up. The return
   * says whether there was anything to give back, so two people pressing at
   * once are told different things.
   */
  async unblock(robloxUserId: bigint, by: { discordName: string; robloxUsername: string }): Promise<boolean> {
    const { count } = await this.db.commandBlock.deleteMany({ where: { robloxUserId } });
    if (count) {
      this.log.info(
        { actor: by.discordName, target: by.robloxUsername },
        `Command access given back to ${by.robloxUsername}`,
      );
    }
    return count > 0;
  }

  /** What the `/config` page reports about the feature's current state. */
  async stats(now = new Date()): Promise<{ servers: number; blocks: number; runsToday: number }> {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [servers, blocks, runsToday] = await Promise.all([
      this.db.commandLogThread.count({ where: { closedAt: null } }),
      this.db.commandBlock.count({ where: { expiresAt: { gt: now } } }),
      this.db.commandLogEntry.count({ where: { occurredAt: { gte: dayAgo } } }),
    ]);
    return { servers, blocks, runsToday };
  }

  /** Drops blocks that have run out. Nothing enforces them any more by then. */
  async cleanupExpiredBlocks(now = new Date()): Promise<number> {
    const { count } = await this.db.commandBlock.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
  }

  /** Closed servers are dropped once their records are, and never come back:
   * a job id belongs to one server for its lifetime. */
  async cleanupClosedServers(retentionDays: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const { count } = await this.db.commandLogThread.deleteMany({ where: { closedAt: { lt: cutoff } } });
    return count;
  }

  /** Old entries are history, not state; the log messages themselves remain. */
  async cleanupEntries(retentionDays: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const { count } = await this.db.commandLogEntry.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return count;
  }
}
