import type { Config } from "../../../core/config.js";
import type { Logger } from "../../../core/logger.js";

type GroupRole = { group?: { id?: number }; role?: { name?: string; rank?: number } };

/** How long a looked-up rank is trusted. A promotion takes effect within this. */
const CACHE_MS = 5 * 60 * 1000;

export type GroupRank = { rankNumber: number; rankName: string };

/**
 * Somebody's rank in the staff group, read straight from Roblox.
 *
 * The game half of this feature never needs it — Adonis already knows the rank
 * of whoever typed the command. This is for the other direction: the person
 * pressing a button in Discord, whose authority has to be resolved through
 * Bloxlink and then through the group, so Discord and the game use one ladder.
 */
export class GroupRankService {
  private readonly cache = new Map<string, { expiresAt: number; value: GroupRank | null }>();
  private readonly log: Logger;

  constructor(private readonly config: Config, log: Logger) {
    this.log = log.child({ category: "command" });
  }

  async forUser(robloxUserId: bigint): Promise<GroupRank | null> {
    const key = robloxUserId.toString();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = await this.fetch(robloxUserId);
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
    return value;
  }

  private async fetch(robloxUserId: bigint): Promise<GroupRank | null> {
    try {
      const response = await fetch(`https://groups.roblox.com/v1/users/${robloxUserId}/groups/roles`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        this.log.warn({ status: response.status, robloxUserId: robloxUserId.toString() }, "Roblox turned down a group rank lookup");
        return null;
      }
      const body = await response.json() as { data?: GroupRole[] };
      const groupId = Number(this.config.ROBLOX_GROUP_ID);
      const membership = body.data?.find((entry) => entry.group?.id === groupId);
      const rankNumber = membership?.role?.rank;
      if (typeof rankNumber !== "number") return null;
      return { rankNumber, rankName: membership?.role?.name ?? `Rank ${rankNumber}` };
    } catch (error) {
      this.log.warn({ err: error, robloxUserId: robloxUserId.toString() }, "Group rank lookup failed");
      return null;
    }
  }
}
