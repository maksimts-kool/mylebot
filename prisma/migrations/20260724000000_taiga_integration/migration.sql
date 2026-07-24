CREATE TYPE "TaigaCardKind" AS ENUM ('BUG', 'SUGGESTION');

CREATE TABLE "TaigaCard" (
  "id" TEXT NOT NULL,
  "taigaStoryId" INTEGER NOT NULL,
  "taigaRef" INTEGER NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "kind" "TaigaCardKind" NOT NULL,
  "title" TEXT NOT NULL,
  "statusName" TEXT NOT NULL,
  "authorDiscordId" TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  "declinedAt" TIMESTAMP(3),
  "deleting" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaigaCard_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaigaCard_taigaStoryId_key" ON "TaigaCard"("taigaStoryId");
CREATE UNIQUE INDEX "TaigaCard_threadId_key" ON "TaigaCard"("threadId");
CREATE INDEX "TaigaCard_statusName_idx" ON "TaigaCard"("statusName");

CREATE TABLE "TaigaWebhookDelivery" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaigaWebhookDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaigaWebhookDelivery_fingerprint_key" ON "TaigaWebhookDelivery"("fingerprint");
CREATE INDEX "TaigaWebhookDelivery_receivedAt_idx" ON "TaigaWebhookDelivery"("receivedAt");

CREATE TABLE "TaigaEpicState" (
  "taigaEpicId" INTEGER NOT NULL,
  "ref" INTEGER NOT NULL,
  "subject" TEXT NOT NULL,
  "statusName" TEXT,
  "isClosed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaigaEpicState_pkey" PRIMARY KEY ("taigaEpicId")
);

CREATE TABLE "TaigaSettings" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "bugForumChannelId" TEXT,
  "suggestionForumChannelId" TEXT,
  "notificationChannelId" TEXT,
  "activatedAt" TIMESTAMP(3),
  "epicsSeededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaigaSettings_pkey" PRIMARY KEY ("id")
);
