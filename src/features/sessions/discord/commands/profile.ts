import { AttachmentBuilder, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type User } from "discord.js";
import { userError } from "../../../../core/errors.js";
import { formatDuration } from "../../../../core/logger.js";
import { BRAND_COLOR } from "../../../../shared/discord/colors.js";
import type { InteractionOutcome } from "../../../../shared/discord/interaction-log.js";
import { profileStats } from "../../domain/profile.js";
import { renderProfileCard } from "../profile-card.js";
import { badgeGuide, profileCardModel } from "../profile-view.js";
import { robloxHeadshot } from "../roblox-avatar.js";
import type { SessionCommandContext } from "./context.js";

/** Who a Discord member is to the tracker. `identity` is null once retention has removed it. */
async function resolveMember(ctx: SessionCommandContext, user: User, isSelf: boolean) {
  const identity = await ctx.db.identity.findFirst({ where: { discordUserId: user.id } });
  if (identity) return { robloxUserId: identity.robloxUserId, robloxUsername: identity.robloxUsername, identity };
  const mapped = await ctx.bloxlink.robloxForDiscord(user.id);
  if (!mapped) userError(isSelf ? "You haven't linked a Roblox account with Bloxlink yet" : "That member hasn't linked a Roblox account with Bloxlink yet");
  const tracked = await ctx.db.identity.findUnique({ where: { robloxUserId: mapped.userId } });
  return { robloxUserId: mapped.userId, robloxUsername: tracked?.robloxUsername ?? mapped.username, identity: tracked };
}

export async function showProfile(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  const user = interaction.options.getUser("user") ?? interaction.user;
  const isSelf = user.id === interaction.user.id;
  await interaction.deferReply();
  const now = new Date();
  const member = await resolveMember(ctx, user, isSelf);
  const standing = await ctx.badges.standing(member.robloxUserId);
  // Somebody the tracker has never seen is untracked, not "zero hours".
  if (!member.identity && !standing.awards.length) {
    userError(isSelf ? "You haven't been tracked on shift yet" : `${member.robloxUsername} hasn't been tracked on shift yet`);
  }

  const sessions = member.identity
    ? await ctx.db.session.findMany({
      where: { identityId: member.identity.id, deletedAt: null },
      select: { startedAt: true, endedAt: true, deletedAt: true, rankName: true, rankNumber: true, segments: { select: { state: true, startedAt: true, endedAt: true } } },
      orderBy: { startedAt: "desc" },
    })
    : [];
  const latest = sessions[0];
  const avatar = await robloxHeadshot(member.robloxUserId);
  const stats = profileStats(sessions, now, ctx.config.REPORT_TIMEZONE);
  const card = await renderProfileCard(profileCardModel({
    robloxUsername: member.robloxUsername,
    rank: latest ? { name: latest.rankName, number: latest.rankNumber } : null,
    avatar,
    stats,
    standing,
    now,
    timezone: ctx.config.REPORT_TIMEZONE,
  }));
  const name = `profile-${member.robloxUsername.toLowerCase().replace(/[^a-z0-9_]/g, "")}.png`;
  await interaction.editReply({ files: [new AttachmentBuilder(card, { name })] });
  return {
    did: `sent the profile card for ${member.robloxUsername}`,
    fields: {
      shifts: stats?.shifts ?? 0,
      pastYear: formatDuration(stats?.yearMs ?? 0),
      badges: standing.awards.length,
      avatar: avatar ? undefined : "missing",
    },
  };
}

export async function showBadgeGuide(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const now = new Date();
  const identity = await ctx.db.identity.findFirst({ where: { discordUserId: interaction.user.id } })
    ?? await ctx.bloxlink.robloxForDiscord(interaction.user.id)
      .then((mapped) => mapped ? ctx.db.identity.findUnique({ where: { robloxUserId: mapped.userId } }) : null);
  let standing = null;
  if (identity) {
    const held = await ctx.badges.standing(identity.robloxUserId);
    // Veteran counts from the first time the tracker saw them, even before the
    // badge pass has recorded it.
    standing = { ...held, firstTrackedAt: held.firstTrackedAt ?? identity.createdAt };
  }
  const guide = badgeGuide({ standing, now, timezone: ctx.config.REPORT_TIMEZONE });
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle("🎖️ How to earn badges")
      .setDescription(guide.description)
      .addFields(guide.fields)
      .setFooter({ text: guide.footer })],
  });
  return {
    did: identity ? `sent the badge guide with ${identity.robloxUsername}'s progress` : "sent the badge guide",
    fields: { badges: standing?.awards.length },
  };
}
