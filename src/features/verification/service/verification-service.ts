import type { Db } from "../../../core/db.js";
import { errorType } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import {
  finalWarningDueAt,
  kickDueAt,
  reminderIsDue,
  shouldKick,
  shouldSendFinalWarning,
  verificationDeadlineAt,
  VERIFICATION_REMINDER_INTERVAL_MS,
} from "../domain/policy.js";

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

export type VerificationStatusMember = UnverifiedMember & {
  firstSeenAt: Date | null;
  warnedAt: Date | null;
  finalWarningDueAt: Date | null;
  removalDueAt: Date | null;
};

export type VerificationStatus = {
  members: VerificationStatusMember[];
  lastReminderAt: Date | null;
  nextReminderAt: Date | null;
  staleTrackedCount: number;
};

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
  private readonly log: Logger;

  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly gateway: VerificationGateway,
    log: Logger,
  ) {
    this.log = log.child({ category: "verify" });
  }

  /** Read-only live view used by the manager status command. */
  async status(): Promise<VerificationStatus> {
    const [members, records, schedule] = await Promise.all([
      this.gateway.listUnverifiedMembers(),
      this.db.verificationMember.findMany({ where: { guildId: this.guildId } }),
      this.db.verificationSchedule.findUnique({ where: { guildId: this.guildId } }),
    ]);
    const membersById = new Map(members.map((member) => [member.discordUserId, member]));
    const recordsById = new Map(records.map((record) => [record.discordUserId, record]));

    const statusMembers = members.map((member): VerificationStatusMember => {
      const record = recordsById.get(member.discordUserId);
      if (!record) {
        return {
          ...member,
          firstSeenAt: null,
          warnedAt: null,
          finalWarningDueAt: null,
          removalDueAt: null,
        };
      }
      return {
        ...member,
        firstSeenAt: record.firstSeenAt,
        warnedAt: record.warnedAt,
        finalWarningDueAt: finalWarningDueAt(record.firstSeenAt),
        removalDueAt: record.warnedAt === null
          ? verificationDeadlineAt(record.firstSeenAt)
          : kickDueAt(record.warnedAt),
      };
    }).sort((left, right) => {
      const leftDue = left.removalDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightDue = right.removalDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return leftDue - rightDue || left.displayName.localeCompare(right.displayName);
    });

    return {
      members: statusMembers,
      lastReminderAt: schedule?.lastReminderAt ?? null,
      nextReminderAt: schedule?.lastReminderAt === null || schedule === null
        ? null
        : new Date(schedule.lastReminderAt.getTime() + VERIFICATION_REMINDER_INTERVAL_MS),
      staleTrackedCount: records.filter((record) => !membersById.has(record.discordUserId)).length,
    };
  }

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
      this.log.error({ action: "general_reminder", err: error, errorType: errorType(error) }, "Could not post the reminder");
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
        this.log.warn({ action: "kick", discordUserId: member.discordUserId, err: error, errorType: errorType(error) }, "Could not remove an unverified member");
      }
    }
    if (removed.length) {
      try {
        await this.gateway.postRemovedMembers(removed);
      } catch (error) {
        hadOperationalFailure = true;
        this.log.error({ action: "removal_notice", removedCount: removed.length, err: error, errorType: errorType(error) }, "Could not post the removal notice");
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
        this.log.error({ action: "final_warning", memberCount: batch.length, err: error, errorType: errorType(error) }, "Could not post the final warning");
      }
    }

    this.log.info({
      unverified: members.length,
      newlySeen: newIds.length,
      finalWarnings: warningMembers.length,
      removed: removed.length,
    }, "Verification pass completed");

    if (hadOperationalFailure) throw new Error("Verification cycle completed with one or more operational failures");
    return true;
  }
}
