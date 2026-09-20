-- Each server's thread now hangs off a live panel message in the channel: who
-- is in that server, and the controls that used to sit under every command.

ALTER TABLE "CommandLogThread" ADD COLUMN "panelMessageId" TEXT;
ALTER TABLE "CommandLogThread" ADD COLUMN "serverType" "CommandServerType" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "CommandLogThread" ADD COLUMN "playerCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CommandLogThread" ADD COLUMN "maxPlayers" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CommandLogThread" ADD COLUMN "staff" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "CommandLogThread" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CommandLogThread" ADD COLUMN "closedAt" TIMESTAMP(3);

CREATE INDEX "CommandLogThread_closedAt_lastSeenAt_idx" ON "CommandLogThread"("closedAt", "lastSeenAt");

-- Access is taken from a person on the server panel now, not from one command
-- run, so a block no longer points at an entry.
ALTER TABLE "CommandBlock" DROP COLUMN "entryId";
