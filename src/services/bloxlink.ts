import type { Config } from "../config.js";
import type { prisma as database } from "../db.js";

type Db = typeof database;
type RobloxMapping = { userId: bigint; username: string };

const ROBLOX_MAPPING_CACHE_MS = 10 * 60 * 1_000;

export class BloxlinkService {
  private readonly robloxMappingCache = new Map<string, { expiresAt: number; value: RobloxMapping }>();
  private readonly robloxMappingRequests = new Map<string, Promise<RobloxMapping | null>>();

  constructor(private readonly db: Db, private readonly config: Config) {}

  private async request(url: string): Promise<Response> {
    return fetch(url, {
      headers: { Authorization: this.config.BLOXLINK_API_KEY },
      signal: AbortSignal.timeout(5_000),
    });
  }

  /** Resolve a Roblox username when Bloxlink supplies only a numeric user ID. */
  private async usernameForRobloxId(robloxUserId: string): Promise<string | null> {
    try {
      const response = await fetch(`https://users.roblox.com/v1/users/${encodeURIComponent(robloxUserId)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        console.warn("Roblox username lookup failed", { status: response.status, robloxUserId });
        return null;
      }
      const body = await response.json() as { name?: unknown };
      return typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    } catch (error) {
      console.warn("Roblox username lookup errored", { error, robloxUserId });
      return null;
    }
  }

  async discordForRoblox(robloxUserId: bigint): Promise<string | null> {
    const identity = await this.db.identity.findUnique({ where: { robloxUserId } });
    const cacheIsFresh = identity?.mappingCheckedAt && Date.now() - identity.mappingCheckedAt.getTime() < 24 * 60 * 60 * 1000;
    if (cacheIsFresh) return identity.discordUserId;
    if (!this.config.BLOXLINK_API_KEY || !this.config.DISCORD_GUILD_ID) return identity?.discordUserId ?? null;

    try {
      const url = `${this.config.BLOXLINK_BASE_URL}/guilds/${this.config.DISCORD_GUILD_ID}/roblox-to-discord/${robloxUserId}`;
      const response = await this.request(url);
      if (!response.ok) {
        console.warn("Bloxlink Roblox-to-Discord request failed", { status: response.status, robloxUserId: robloxUserId.toString() });
        return identity?.discordUserId ?? null;
      }
      const body = await response.json() as { discordIDs?: string[] };
      const discordUserId = body.discordIDs?.[0] ?? null;
      await this.db.identity.update({ where: { robloxUserId }, data: { discordUserId, mappingCheckedAt: new Date() } });
      return discordUserId;
    } catch (error) {
      console.warn("Bloxlink Roblox-to-Discord request errored", { error, robloxUserId: robloxUserId.toString() });
      return identity?.discordUserId ?? null;
    }
  }

  async robloxForDiscord(discordUserId: string): Promise<RobloxMapping | null> {
    const cached = await this.db.identity.findFirst({ where: { discordUserId } });
    if (cached) return { userId: cached.robloxUserId, username: cached.robloxUsername };
    const cachedMapping = this.robloxMappingCache.get(discordUserId);
    if (cachedMapping && cachedMapping.expiresAt > Date.now()) return cachedMapping.value;
    const pending = this.robloxMappingRequests.get(discordUserId);
    if (pending) return pending;

    const request = this.fetchRobloxForDiscord(discordUserId);
    this.robloxMappingRequests.set(discordUserId, request);
    try {
      const mapping = await request;
      if (mapping) {
        this.robloxMappingCache.set(discordUserId, {
          value: mapping,
          expiresAt: Date.now() + ROBLOX_MAPPING_CACHE_MS,
        });
      }
      return mapping;
    } finally {
      this.robloxMappingRequests.delete(discordUserId);
    }
  }

  private async fetchRobloxForDiscord(discordUserId: string): Promise<RobloxMapping | null> {
    if (!this.config.BLOXLINK_API_KEY || !this.config.DISCORD_GUILD_ID) return null;
    try {
      const url = `${this.config.BLOXLINK_BASE_URL}/guilds/${this.config.DISCORD_GUILD_ID}/discord-to-roblox/${discordUserId}`;
      const response = await this.request(url);
      if (!response.ok) {
        console.warn("Bloxlink Discord-to-Roblox request failed", { status: response.status, discordUserId });
        return null;
      }
      const body = await response.json() as {
        robloxID?: string | number;
        resolved?: { roblox?: { id?: string | number; name?: string } };
      };
      const rawId = body.robloxID ?? body.resolved?.roblox?.id;
      if (rawId === undefined || rawId === null) return null;
      const id = String(rawId);
      if (!/^\d+$/.test(id)) return null;
      const username = body.resolved?.roblox?.name?.trim() || await this.usernameForRobloxId(id);
      return { userId: BigInt(id), username: username ?? `Roblox ${id}` };
    } catch (error) {
      console.warn("Bloxlink Discord-to-Roblox request errored", { error, discordUserId });
      return null;
    }
  }
}
