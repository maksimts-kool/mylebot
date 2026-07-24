import type { Client } from "discord.js";
import type { Config } from "../../../core/config.js";
import { errorType } from "../../../core/errors.js";
import type { VerifiedGuildMember } from "../api/routes.js";

const VERIFIED_MEMBER_CACHE_MS = 5 * 60 * 1000;

/**
 * Lists every member that currently has Bloxlink's Verified role in the bot's
 * guild. This deliberately does not use the session-tracker Identity table:
 * someone can be assigned a store before they ever play in the game.
 */
export class VerifiedMemberDirectory {
  private cache: { expiresAt: number; members: VerifiedGuildMember[] } | null = null;
  private refresh: Promise<VerifiedGuildMember[]> | null = null;

  constructor(private readonly client: Client, private readonly config: Config) {}

  async list(): Promise<VerifiedGuildMember[]> {
    if (!this.client.isReady()) return [];
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.members;
    if (this.refresh) return this.refresh;
    this.refresh = this.load();
    try {
      const members = await this.refresh;
      this.cache = { members, expiresAt: Date.now() + VERIFIED_MEMBER_CACHE_MS };
      return members;
    } finally {
      this.refresh = null;
    }
  }

  private async load(): Promise<VerifiedGuildMember[]> {
    if (!this.config.DISCORD_GUILD_ID) return [];
    try {
      const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
      const roles = await guild.roles.fetch();
      const verifiedRole = roles.find((role) => role.name.trim().toLowerCase() === "verified");
      if (!verifiedRole) {
        console.warn("Verified member list failed", { reason: "verified_role_missing" });
        return [];
      }

      const members: VerifiedGuildMember[] = [];
      let after: string | undefined;
      do {
        const page = await guild.members.list({ limit: 1_000, cache: false, ...(after ? { after } : {}) });
        for (const member of page.values()) {
          if (!member.roles.cache.has(verifiedRole.id)) continue;
          members.push({
            discordId: member.id,
            discordName: member.displayName,
            // The verified role is the source of truth here. Fetching a Roblox
            // name for every guild member would needlessly hammer Bloxlink's API.
            robloxUsername: null,
          });
        }
        if (page.size < 1_000) break;
        after = page.lastKey();
      } while (after);

      return members.sort((a, b) => a.discordName.localeCompare(b.discordName));
    } catch (error) {
      console.warn("Verified member list failed", { errorType: errorType(error) });
      return [];
    }
  }
}
