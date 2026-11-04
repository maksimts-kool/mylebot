-- Staff badges and the profile card. Badge rows are keyed by Roblox user id
-- with no foreign keys, so they survive the one-year session retention that
-- deletes sessions and identities; the low-rank purge removes them explicitly.

CREATE TABLE "BadgeSettings" (
    "id" TEXT NOT NULL,
    "launchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monthsAwardedThrough" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BadgeSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BadgeProgress" (
    "robloxUserId" BIGINT NOT NULL,
    "firstTrackedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BadgeProgress_pkey" PRIMARY KEY ("robloxUserId")
);

CREATE TABLE "BadgeCredit" (
    "sessionId" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "activeMilliseconds" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BadgeCredit_pkey" PRIMARY KEY ("sessionId")
);

CREATE INDEX "BadgeCredit_robloxUserId_idx" ON "BadgeCredit"("robloxUserId");

CREATE TABLE "BadgeAward" (
    "id" TEXT NOT NULL,
    "robloxUserId" BIGINT NOT NULL,
    "badge" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT '',
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "BadgeAward_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BadgeAward_robloxUserId_badge_period_key" ON "BadgeAward"("robloxUserId", "badge", "period");
CREATE INDEX "BadgeAward_notifiedAt_idx" ON "BadgeAward"("notifiedAt");
