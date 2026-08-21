export const VERIFICATION_REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
export const VERIFICATION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const FINAL_WARNING_GRACE_MS = VERIFICATION_REMINDER_INTERVAL_MS;
export const VERIFICATION_PERIOD_MS = 10 * VERIFICATION_REMINDER_INTERVAL_MS;

export type VerificationRecord = {
  discordUserId: string;
  firstSeenAt: Date;
  warnedAt: Date | null;
};

/** The final reminder is the scheduled post immediately before day 30. */
export function finalWarningDueAt(firstSeenAt: Date): Date {
  return new Date(firstSeenAt.getTime() + VERIFICATION_PERIOD_MS - FINAL_WARNING_GRACE_MS);
}

export function verificationDeadlineAt(firstSeenAt: Date): Date {
  return new Date(firstSeenAt.getTime() + VERIFICATION_PERIOD_MS);
}

export function kickDueAt(warnedAt: Date): Date {
  return new Date(warnedAt.getTime() + FINAL_WARNING_GRACE_MS);
}

export function shouldSendFinalWarning(record: VerificationRecord, now: Date): boolean {
  return record.warnedAt === null && finalWarningDueAt(record.firstSeenAt).getTime() <= now.getTime();
}

export function shouldKick(record: VerificationRecord, now: Date): boolean {
  return record.warnedAt !== null
    && kickDueAt(record.warnedAt).getTime() <= now.getTime();
}

export function reminderIsDue(lastReminderAt: Date | null, now: Date): boolean {
  return lastReminderAt === null
    || lastReminderAt.getTime() + VERIFICATION_REMINDER_INTERVAL_MS <= now.getTime();
}
