import type { Config } from "../config.js";
import type { prisma as database } from "../db.js";

type Db = typeof database;

export class BloxlinkService {
  constructor(private readonly db: Db, private readonly config: Config) {}

  async discordForRoblox(robloxUserId: bigint): Promise<string | null> {
    const identity = await this.db.identity.findUnique({ where: { robloxUserId } });
    const cacheIsFresh = identity?.mappingCheckedAt && Date.now() - identity.mappingCheckedAt.getTime() < 24 * 60 * 60 * 1000;
    if (cacheIsFresh) return identity.discordUserId;
    if (!this.config.BLOXLINK_API_KEY || !this.config.DISCORD_GUILD_ID) return identity?.discordUserId ?? null;

    try {
      const url = `${this.config.BLOXLINK_BASE_URL}/guilds/${this.config.DISCORD_GUILD_ID}/roblox-to-discord/${robloxUserId}`;
      const response = await fetch(url, { headers: { Authorization: this.config.BLOXLINK_API_KEY } });
      if (!response.ok) return identity?.discordUserId ?? null;
      const body = await response.json() as { discordIDs?: string[] };
      const discordUserId = body.discordIDs?.[0] ?? null;
      await this.db.identity.update({ where: { robloxUserId }, data: { discordUserId, mappingCheckedAt: new Date() } });
      return discordUserId;
    } catch {
      return identity?.discordUserId ?? null;
    }
  }

  async robloxForDiscord(discordUserId: string): Promise<{ userId: bigint; username: string } | null> {
    const cached = await this.db.identity.findFirst({ where: { discordUserId } });
    if (cached) return { userId: cached.robloxUserId, username: cached.robloxUsername };
    if (!this.config.BLOXLINK_API_KEY || !this.config.DISCORD_GUILD_ID) return null;
    try {
      const url = `${this.config.BLOXLINK_BASE_URL}/guilds/${this.config.DISCORD_GUILD_ID}/discord-to-roblox/${discordUserId}`;
      const response = await fetch(url, { headers: { Authorization: this.config.BLOXLINK_API_KEY } });
      if (!response.ok) return null;
      const body = await response.json() as { robloxID?: string; resolved?: { roblox?: { id?: string; name?: string } } };
      const id = body.robloxID ?? body.resolved?.roblox?.id;
      if (!id) return null;
      return { userId: BigInt(id), username: body.resolved?.roblox?.name ?? `Roblox ${id}` };
    } catch {
      return null;
    }
  }
}
