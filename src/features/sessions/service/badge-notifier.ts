import type { BadgeAward } from "@prisma/client";
import type { Db } from "../../../core/db.js";
import { LinkUnavailableError } from "../../../core/link.js";
import type { Logger } from "../../../core/logger.js";
import type { BloxlinkService } from "../../../shared/bloxlink.js";
import type { SessionsBotPort } from "../link.js";
import type { BadgeService } from "./badge-service.js";

/** Discord allows ten embeds on one message, so one DM carries at most ten badges. */
const AWARDS_PER_DM = 10;

/**
 * Tells members about badges they have earned, one DM per person per pass.
 * An award is marked told once the DM is sent, or once it is clear it never can
 * be — no linked Discord account, DMs closed — so nothing is retried forever.
 * Anything else leaves the award owed for the next pass.
 *
 * Awards are rows first and DMs second: this side decides who is owed what,
 * and the bot half only draws and sends the message.
 */
export class BadgeNotifier {
  private readonly log: Logger;

  constructor(
    private readonly db: Db,
    private readonly badges: BadgeService,
    private readonly bloxlink: BloxlinkService,
    private readonly discord: SessionsBotPort,
    log: Logger,
  ) {
    this.log = log.child({ category: "discord" });
  }

  /** Returns how many members were sent a DM. */
  async notifyOwed(): Promise<number> {
    const owed = await this.badges.owedNotifications();
    const byMember = new Map<bigint, BadgeAward[]>();
    for (const award of owed) byMember.set(award.robloxUserId, [...(byMember.get(award.robloxUserId) ?? []), award]);

    let sent = 0;
    for (const [robloxUserId, awards] of byMember) {
      const ids = awards.map(({ id }) => id);
      const identity = await this.db.identity.findUnique({ where: { robloxUserId }, select: { robloxUsername: true } });
      const discordUserId = identity ? await this.bloxlink.discordForRoblox(robloxUserId) : null;
      if (!identity || !discordUserId) {
        await this.badges.markNotified(ids);
        continue;
      }
      const { activeMs } = await this.badges.standing(robloxUserId);
      const shown = awards.slice(0, AWARDS_PER_DM);
      let result: Awaited<ReturnType<SessionsBotPort["sendBadgeDm"]>>;
      try {
        result = await this.discord.sendBadgeDm({
          discordUserId,
          robloxUsername: identity.robloxUsername,
          awards: shown.map(({ badge, period }) => ({ badge, period })),
          activeMs,
        });
      } catch (error) {
        // Discord being away is not news; the awards are simply still owed.
        if (!(error instanceof LinkUnavailableError)) {
          this.log.warn({ err: error, actor: identity.robloxUsername }, "Badge DM failed; it will be retried");
        }
        break;
      }
      if (result === "sent") {
        await this.badges.markNotified(shown.map(({ id }) => id));
        sent += 1;
      } else {
        // Unreachable, or nothing in the batch is a badge any more: telling
        // them can never succeed, so stop owing it.
        await this.badges.markNotified(ids);
      }
    }
    return sent;
  }
}
