import { AttachmentBuilder, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { formatDuration } from "../../../../core/logger.js";
import { BRAND_COLOR } from "../../../../shared/discord/colors.js";
import type { InteractionOutcome } from "../../../../shared/discord/interaction-log.js";
import { renderProfileCard } from "../profile-card.js";
import { badgeGuide, profileCardModel } from "../profile-view.js";
import type { SessionCommandContext } from "./context.js";

export async function showProfile(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  const user = interaction.options.getUser("user") ?? interaction.user;
  const isSelf = user.id === interaction.user.id;
  await interaction.deferReply();
  const now = new Date();
  // The server half decides who this is and refuses an untracked member.
  const profile = await ctx.sessions.profile(user.id, isSelf);
  const card = await renderProfileCard(profileCardModel({
    robloxUsername: profile.robloxUsername,
    rank: profile.rank,
    avatar: profile.avatar,
    stats: profile.stats,
    standing: profile.standing,
    now,
    timezone: ctx.config.REPORT_TIMEZONE,
  }));
  const name = `profile-${profile.robloxUsername.toLowerCase().replace(/[^a-z0-9_]/g, "")}.png`;
  await interaction.editReply({ files: [new AttachmentBuilder(card, { name })] });
  return {
    did: `sent the profile card for ${profile.robloxUsername}`,
    fields: {
      shifts: profile.stats?.shifts ?? 0,
      pastYear: formatDuration(profile.stats?.yearMs ?? 0),
      badges: profile.standing.awards.length,
      avatar: profile.avatar ? undefined : "missing",
    },
  };
}

export async function showBadgeGuide(ctx: SessionCommandContext, interaction: ChatInputCommandInteraction): Promise<InteractionOutcome> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const now = new Date();
  const progress = await ctx.sessions.badgeGuide(interaction.user.id);
  const guide = badgeGuide({ standing: progress?.standing ?? null, now, timezone: ctx.config.REPORT_TIMEZONE });
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle("🎖️ How to earn badges")
      .setDescription(guide.description)
      .addFields(guide.fields)
      .setFooter({ text: guide.footer })],
  });
  return {
    did: progress ? `sent the badge guide with ${progress.robloxUsername}'s progress` : "sent the badge guide",
    fields: { badges: progress?.standing.awards.length },
  };
}
