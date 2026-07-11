CREATE TYPE "SessionState" AS ENUM ('ACTIVE', 'INACTIVE', 'RECONNECTING', 'ENDED');
CREATE TYPE "EventKind" AS ENUM ('JOIN', 'HEARTBEAT', 'LEAVE', 'SHUTDOWN');

CREATE TABLE "Identity" (
  "id" TEXT NOT NULL,
  "robloxUserId" BIGINT NOT NULL,
  "robloxUsername" TEXT NOT NULL,
  "discordUserId" TEXT,
  "mappingCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Identity_robloxUserId_key" ON "Identity"("robloxUserId");
CREATE INDEX "Identity_discordUserId_idx" ON "Identity"("discordUserId");

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "identityId" TEXT NOT NULL,
  "state" "SessionState" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3) NOT NULL,
  "lastStateAt" TIMESTAMP(3) NOT NULL,
  "reconnectDeadline" TIMESTAMP(3),
  "activeMilliseconds" BIGINT NOT NULL DEFAULT 0,
  "inactiveMilliseconds" BIGINT NOT NULL DEFAULT 0,
  "reconnectMilliseconds" BIGINT NOT NULL DEFAULT 0,
  "rankNumber" INTEGER NOT NULL,
  "rankName" TEXT NOT NULL,
  "universeId" BIGINT NOT NULL,
  "placeId" BIGINT NOT NULL,
  "jobId" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Session_identityId_startedAt_idx" ON "Session"("identityId", "startedAt");
CREATE INDEX "Session_state_reconnectDeadline_idx" ON "Session"("state", "reconnectDeadline");
CREATE INDEX "Session_deletedAt_startedAt_idx" ON "Session"("deletedAt", "startedAt");

CREATE TABLE "TimeSegment" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "state" "SessionState" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "TimeSegment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeSegment_sessionId_startedAt_idx" ON "TimeSegment"("sessionId", "startedAt");

CREATE TABLE "DiscordMessage" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscordMessage_sessionId_key" ON "DiscordMessage"("sessionId");

CREATE TABLE "ProcessedEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "kind" "EventKind" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sessionId" TEXT,
  CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcessedEvent_eventId_key" ON "ProcessedEvent"("eventId");
CREATE INDEX "ProcessedEvent_receivedAt_idx" ON "ProcessedEvent"("receivedAt");

CREATE TABLE "AuditEntry" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "note" TEXT,
  "before" JSONB,
  "after" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEntry_sessionId_createdAt_idx" ON "AuditEntry"("sessionId", "createdAt");

ALTER TABLE "Session" ADD CONSTRAINT "Session_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeSegment" ADD CONSTRAINT "TimeSegment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscordMessage" ADD CONSTRAINT "DiscordMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
