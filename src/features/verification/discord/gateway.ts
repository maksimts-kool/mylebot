import { escapeMarkdown, type Client, type GuildMember, type SendableChannels } from "discord.js";
import type { Config } from "../../../core/config.js";
import type { UnverifiedMember, VerificationGateway } from "../service/verification-service.js";

const FINAL_WARNING_TEXT = "You have 3 days left to verify. Please do it now or you will be removed from the server.";
const REMOVAL_REASON = "Verification deadline expired after the final 3-day warning";

export class DiscordVerificationGateway implements VerificationGateway {
  private readonly members = new Map<string, GuildMember>();

  constructor(private readonly client: Client, private readonly config: Config) {}

  async listUnverifiedMembers(): Promise<UnverifiedMember[]> {
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
    const role = await guild.roles.fetch(this.config.VERIFICATION_UNVERIFIED_ROLE_ID);
    if (!role) throw new Error("Configured Unverified role was not found");

    const guildMembers = await guild.members.fetch();
    this.members.clear();
    const result: UnverifiedMember[] = [];
    for (const member of guildMembers.values()) {
      if (member.user.bot || !member.roles.cache.has(role.id)) continue;
      this.members.set(member.id, member);
      result.push({ discordUserId: member.id, displayName: member.displayName });
    }
    return result;
  }

  async postGeneralReminder(): Promise<void> {
    const channel = await this.channel();
    await channel.send({
      content: `<@&${this.config.VERIFICATION_UNVERIFIED_ROLE_ID}> Please verify your account in this channel. You have one month to verify before you receive a final 3-day warning.`,
      allowedMentions: { roles: [this.config.VERIFICATION_UNVERIFIED_ROLE_ID] },
    });
  }

  async postFinalWarning(members: UnverifiedMember[]): Promise<void> {
    const channel = await this.channel();
    await channel.send({
      content: `${members.map(({ discordUserId }) => `<@${discordUserId}>`).join(" ")}\n\n${FINAL_WARNING_TEXT}`,
      allowedMentions: { users: members.map(({ discordUserId }) => discordUserId) },
    });
  }

  async postRemovedMembers(members: UnverifiedMember[]): Promise<void> {
    const channel = await this.channel();
    const names = members.map(({ displayName }) => `@${escapeMarkdown(displayName)}`);
    const heading = "Removed after their final 3-day verification warning:";
    let lines: string[] = [];
    let length = heading.length + 2;
    for (const name of names) {
      if (lines.length && length + name.length + 1 > 2_000) {
        await channel.send({ content: `${heading}\n${lines.join("\n")}`, allowedMentions: { parse: [] } });
        lines = [];
        length = heading.length + 2;
      }
      lines.push(name);
      length += name.length + 1;
    }
    if (lines.length) {
      await channel.send({ content: `${heading}\n${lines.join("\n")}`, allowedMentions: { parse: [] } });
    }
  }

  async kick(member: UnverifiedMember): Promise<void> {
    const guildMember = this.members.get(member.discordUserId);
    if (!guildMember) throw new Error("Member was not present in the current verification cycle");
    await guildMember.kick(REMOVAL_REASON);
  }

  private async channel(): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(this.config.VERIFICATION_CHANNEL_ID);
    if (!channel?.isSendable()) throw new Error("Configured verification channel is not sendable");
    if ("guildId" in channel && channel.guildId !== this.config.DISCORD_GUILD_ID) {
      throw new Error("Configured verification channel belongs to a different guild");
    }
    return channel;
  }
}
