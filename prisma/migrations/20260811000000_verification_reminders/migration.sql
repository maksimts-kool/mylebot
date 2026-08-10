CREATE TABLE "VerificationMember" (
  "guildId" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "warnedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerificationMember_pkey" PRIMARY KEY ("guildId", "discordUserId")
);

CREATE INDEX "VerificationMember_guildId_firstSeenAt_idx"
  ON "VerificationMember"("guildId", "firstSeenAt");

CREATE INDEX "VerificationMember_guildId_warnedAt_idx"
  ON "VerificationMember"("guildId", "warnedAt");

CREATE TABLE "VerificationSchedule" (
  "guildId" TEXT NOT NULL,
  "lastReminderAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerificationSchedule_pkey" PRIMARY KEY ("guildId")
);
