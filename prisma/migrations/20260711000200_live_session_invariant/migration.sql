-- A Roblox identity may have at most one non-deleted live session.
CREATE UNIQUE INDEX "Session_one_live_per_identity_key"
ON "Session" ("identityId")
WHERE "state" <> 'ENDED' AND "deletedAt" IS NULL;
