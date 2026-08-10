import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import { reminderIsDue, shouldKick, shouldSendFinalWarning } from "../domain/policy.js";

export type UnverifiedMember = {
  discordUserId: string;
  displayName: string;
};

export interface VerificationGateway {
  listUnverifiedMembers(): Promise<UnverifiedMember[]>;
  postGeneralReminder(): Promise<void>;
  postFinalWarning(members: UnverifiedMember[]): Promise<void>;
  postRemovedMembers(members: UnverifiedMember[]): Promise<void>;
  kick(member: UnverifiedMember): Promise<void>;
}

const FINAL_WARNING_TEXT = "You have 3 days left to verify. Please do it now or you will be removed from the server.";

/** Keep each warning safely under Discord's 2,000-character message limit. */
export function finalWarningBatches(members: UnverifiedMember[], limit = 2_000): UnverifiedMember[][] {
  const batches: UnverifiedMember[][] = [];
  let current: UnverifiedMember[] = [];
  let currentLength = FINAL_WARNING_TEXT.length + 2;

  for (const member of members) {
    const mentionLength = `<@${member.discordUserId}>`.length + (current.length ? 1 : 0);
    if (current.length && currentLength + mentionLength > limit) {
      batches.push(current);
      current = [];
      currentLength = FINAL_WARNING_TEXT.length + 2;
    }
    current.push(member);
    currentLength += `<@${member.discordUserId}>`.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) batches.push(current);
  return batches;
}

export class VerificationService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly gateway: VerificationGateway,
    private readonly log: FastifyBaseLogger,
  ) {}

  async run(now = new Date()): Promise<boolean> {
    const schedule = await this.db.verificationSchedule.findUnique({ where: { guildId: this.guildId } });
    if (!reminderIsDue(schedule?.lastReminderAt ?? null, now)) return false;

    const members = await this.gateway.listUnverifiedMembers();
    const membersById = new Map(members.map((member) => [member.discordUserId, member]));
    const memberIds = [...membersById.keys()];

    // Verification or leaving the guild removes the persisted deadline. If the
    // role is assigned again later, the member receives a fresh month.
    if (memberIds.length) {
      await this.db.verificationMember.deleteMany({
        where: { guildId: this.guildId, discordUserId: { notIn: memberIds } },
      });
    } else {
      await this.db.verificationMember.deleteMany({ where: { guildId: this.guildId } });
    }

    const records = memberIds.length
      ? await this.db.verificationMember.findMany({
        where: { guildId: this.guildId, discordUserId: { in: memberIds } },
      })
      : [];
    const trackedIds = new Set(records.map(({ discordUserId }) => discordUserId));
    const newIds = memberIds.filter((id) => !trackedIds.has(id));
    if (newIds.length) {
      await this.db.verificationMember.createMany({
        data: newIds.map((discordUserId) => ({
          guildId: this.guildId,
          discordUserId,
          firstSeenAt: now,
        })),
        skipDuplicates: true,
      });
    }

    let hadOperationalFailure = false;
    try {
      await this.gateway.postGeneralReminder();
      await this.db.verificationSchedule.upsert({
        where: { guildId: this.guildId },
        create: { guildId: this.guildId, lastReminderAt: now },
        update: { lastReminderAt: now },
      });
    } catch (error) {
      hadOperationalFailure = true;
      this.log.error({ feature: "verification", action: "general_reminder", errorType: errorType(error) }, "Verification reminder could not be posted");
    }

    const removed: UnverifiedMember[] = [];
    for (const record of records.filter((candidate) => shouldKick(candidate, now))) {
      const member = membersById.get(record.discordUserId);
      if (!member) continue;
      try {
        await this.gateway.kick(member);
        removed.push(member);
        await this.db.verificationMember.delete({
          where: { guildId_discordUserId: { guildId: this.guildId, discordUserId: member.discordUserId } },
        });
      } catch (error) {
        hadOperationalFailure = true;
        this.log.warn({ feature: "verification", action: "kick", discordUserId: member.discordUserId, errorType: errorType(error) }, "Unverified member could not be removed");
      }
    }
    if (removed.length) {
      try {
        await this.gateway.postRemovedMembers(removed);
      } catch (error) {
        hadOperationalFailure = true;
        this.log.error({ feature: "verification", action: "removal_notice", removedCount: removed.length, errorType: errorType(error) }, "Verification removal notice could not be posted");
      }
    }

    const warningMembers = records
      .filter((record) => shouldSendFinalWarning(record, now))
      .map((record) => membersById.get(record.discordUserId))
      .filter((member): member is UnverifiedMember => member !== undefined);
    for (const batch of finalWarningBatches(warningMembers)) {
      try {
        await this.gateway.postFinalWarning(batch);
        await this.db.verificationMember.updateMany({
          where: {
            guildId: this.guildId,
            discordUserId: { in: batch.map(({ discordUserId }) => discordUserId) },
            warnedAt: null,
          },
          data: { warnedAt: now },
        });
      } catch (error) {
        hadOperationalFailure = true;
        this.log.error({ feature: "verification", action: "final_warning", memberCount: batch.length, errorType: errorType(error) }, "Final verification warning could not be posted");
      }
    }

    this.log.info({
      feature: "verification",
      unverifiedCount: members.length,
      firstObservedCount: newIds.length,
      finalWarningCount: warningMembers.length,
      removedCount: removed.length,
    }, "Verification cycle completed");

    if (hadOperationalFailure) throw new Error("Verification cycle completed with one or more operational failures");
    return true;
  }
}
