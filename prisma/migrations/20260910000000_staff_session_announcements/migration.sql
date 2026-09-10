-- The staff chat channel the bot announces shifts in. Empty leaves announcements off.
ALTER TABLE "RuntimeSettings" ADD COLUMN "staffChannelId" TEXT;

-- One announcement message per session, kept apart from the session-log message
-- so the two channels can be configured and edited independently.
CREATE TABLE "SessionAnnouncement" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SessionAnnouncement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SessionAnnouncement_sessionId_key" ON "SessionAnnouncement"("sessionId");
ALTER TABLE "SessionAnnouncement" ADD CONSTRAINT "SessionAnnouncement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
