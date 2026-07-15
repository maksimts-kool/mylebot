import { z } from "zod";

// Resolves a Discord user to a Roblox identity. Uses Bloxlink when configured
// (same public API as src/services/bloxlink.ts); otherwise falls back to a
// deterministic synthetic mapping so the demo runs with no external services.

export interface RobloxIdentity {
  userId: string;
  username: string;
}

const bloxlinkSchema = z.object({
  robloxID: z.string().optional(),
  resolved: z.object({ roblox: z.object({ id: z.string().optional(), name: z.string().optional() }).optional() }).optional(),
});

export interface IdentityConfig {
  bloxlinkApiKey: string | null;
  bloxlinkBaseUrl: string;
  guildId: string | null;
}

export class IdentityService {
  constructor(private readonly config: IdentityConfig) {}

  get usingBloxlink(): boolean {
    return Boolean(this.config.bloxlinkApiKey) && Boolean(this.config.guildId);
  }

  async robloxForDiscord(discordUserId: string): Promise<RobloxIdentity | null> {
    if (!this.usingBloxlink) return syntheticIdentity(discordUserId);
    try {
      const url = `${this.config.bloxlinkBaseUrl}/guilds/${this.config.guildId}/discord-to-roblox/${discordUserId}`;
      const response = await fetch(url, {
        headers: { Authorization: this.config.bloxlinkApiKey ?? "" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body = bloxlinkSchema.parse(await response.json());
      const id = body.robloxID ?? body.resolved?.roblox?.id;
      if (!id) return null;
      return { userId: id, username: body.resolved?.roblox?.name ?? `Roblox ${id}` };
    } catch {
      return null;
    }
  }
}

/** Deterministic fake Roblox identity derived from the Discord id, for offline demos. */
export function syntheticIdentity(discordUserId: string): RobloxIdentity {
  let hash = 0;
  for (const char of discordUserId) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_007;
  const userId = String(10_000_000 + (hash % 89_999_999));
  return { userId, username: `DemoPlayer_${userId.slice(-4)}` };
}
