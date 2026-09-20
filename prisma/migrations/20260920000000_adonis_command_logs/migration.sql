-- Adonis command logging: settings, one thread per Roblox server, the command
-- runs themselves, and the temporary command blocks the Roblox plugin polls.

CREATE TYPE "CommandServerType" AS ENUM ('PUBLIC', 'STUDIO');
CREATE TYPE "CommandRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TABLE "CommandLogSettings" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "channelId" TEXT,
  "includeStudio" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommandLogSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommandLogThread" (
  "jobId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "placeId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastPostedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommandLogThread_pkey" PRIMARY KEY ("jobId")
);

CREATE UNIQUE INDEX "CommandLogThread_threadId_key" ON "CommandLogThread"("threadId");
CREATE INDEX "CommandLogThread_lastPostedAt_idx" ON "CommandLogThread"("lastPostedAt");

CREATE TABLE "CommandLogEntry" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "placeId" BIGINT NOT NULL,
  "robloxUserId" BIGINT NOT NULL,
  "robloxUsername" TEXT NOT NULL,
  "rankNumber" INTEGER NOT NULL,
  "rankName" TEXT NOT NULL,
  "adminLevel" INTEGER NOT NULL,
  "requiredLevel" INTEGER NOT NULL,
  "commandText" TEXT NOT NULL,
  "commandName" TEXT NOT NULL,
  "commandAlias" TEXT NOT NULL,
  "serverType" "CommandServerType" NOT NULL,
  "playerCount" INTEGER NOT NULL,
  "maxPlayers" INTEGER NOT NULL,
  "risk" "CommandRisk" NOT NULL,
  "targets" TEXT[],
  "threadId" TEXT,
  "messageId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommandLogEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommandLogEntry_eventId_key" ON "CommandLogEntry"("eventId");
CREATE INDEX "CommandLogEntry_robloxUserId_occurredAt_idx" ON "CommandLogEntry"("robloxUserId", "occurredAt");
CREATE INDEX "CommandLogEntry_createdAt_idx" ON "CommandLogEntry"("createdAt");

CREATE TABLE "CommandBlock" (
  "robloxUserId" BIGINT NOT NULL,
  "robloxUsername" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "byDiscordUserId" TEXT NOT NULL,
  "byDiscordName" TEXT NOT NULL,
  "entryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommandBlock_pkey" PRIMARY KEY ("robloxUserId")
);

CREATE INDEX "CommandBlock_expiresAt_idx" ON "CommandBlock"("expiresAt");
