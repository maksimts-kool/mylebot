import { AttachmentBuilder, DiscordAPIError, EmbedBuilder, RESTJSONErrorCodes, type Client } from "discord.js";
import type { BadgeAward } from "@prisma/client";
import type { Config } from "../../../core/config.js";
import type { Db } from "../../../core/db.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import { BRAND_COLOR } from "../../../shared/discord/colors.js";
import { badgeByKey } from "../domain/badges.js";
import type { BadgeService } from "../service/badge-service.js";
import { renderBadgeIcon } from "./profile-card.js";
import { awardSentence } from "./profile-view.js";

/** Discord allows ten embeds on one message. */
const EMBEDS_PER_MESSAGE = 10;

/** Errors that mean this person can never be reached, so retrying is pointless. */
const UNREACHABLE = new Set<number>([RESTJSONErrorCodes.CannotSendMessagesToThisUser, RESTJSONErrorCodes.UnknownUser]);

/**
 * Tells members about badges they have earned, one DM per person per pass.
 * An award is marked told once the DM is sent, or once it is clear it never can
 * be — no linked Discord account, DMs closed — so nothing is retried forever.
 * Anything else leaves the award owed for the next pass.
 */
export class BadgeNotifier {
  private readonly log: Logger;

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: Config,
    private readonly badges: BadgeService,
    private readonly bloxlink: BloxlinkService,
    log: Logger,
  ) {
    this.log = log.child({ category: "discord" });
  }

  /** Returns how many members were sent a DM. */
  async notifyOwed(): Promise<number> {
    if (!this.client.isReady()) return 0;
    const owed = await this.badges.owedNotifications();
    const byMember = new Map<bigint, BadgeAward[]>();
    for (const award of owed) byMember.set(award.robloxUserId, [...(byMember.get(award.robloxUserId) ?? []), award]);

    let sent = 0;
    for (const [robloxUserId, awards] of byMember) {
      const ids = awards.map(({ id }) => id);
      const identity = await this.db.identity.findUnique({ where: { robloxUserId }, select: { robloxUsername: true } });
      const discordUserId = identity ? await this.bloxlink.discordForRoblox(robloxUserId) : null;
      if (!discordUserId) {
        await this.badges.markNotified(ids);
        continue;
      }
      const { activeMs } = await this.badges.standing(robloxUserId);
      const shown = awards.slice(0, EMBEDS_PER_MESSAGE);
      const files: AttachmentBuilder[] = [];
      const embeds: EmbedBuilder[] = [];
      for (const [index, award] of shown.entries()) {
        const badge = badgeByKey(award.badge);
        if (!badge) continue;
        const name = `badge-${index}.png`;
        files.push(new AttachmentBuilder(await renderBadgeIcon(badge, 128), { name }));
        embeds.push(new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle(`${badge.emoji} New badge: ${badge.name}`)
          .setDescription(awardSentence(badge, award.period, activeMs, this.config.REPORT_TIMEZONE))
          .setThumbnail(`attachment://${name}`)
          .setFooter({ text: "Use /profile to see all your badges" }));
      }
      if (!embeds.length) {
        await this.badges.markNotified(ids);
        continue;
      }
      try {
        await this.client.users.send(discordUserId, { embeds, files });
        await this.badges.markNotified(shown.map(({ id }) => id));
        sent += 1;
        this.log.info({ actor: identity?.robloxUsername, badges: shown.map(({ badge }) => badge).join(", ") }, "Told a member about a new badge");
      } catch (error) {
        if (error instanceof DiscordAPIError && typeof error.code === "number" && UNREACHABLE.has(error.code)) {
          await this.badges.markNotified(ids);
          this.log.debug({ actor: identity?.robloxUsername }, "Could not DM a member about a badge; their DMs are closed");
          continue;
        }
        this.log.warn({ err: error, actor: identity?.robloxUsername }, "Badge DM failed; it will be retried");
        break;
      }
    }
    return sent;
  }
}
