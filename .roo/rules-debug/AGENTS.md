# Debug-mode guidance

- Tests use Fastify injection and plain-object Prisma test doubles, often cast through `never`, not a test database.
- `/health` is process liveness; `/ready` checks database readiness.
- Diagnose timing with timestamps, accumulated counters, and segment boundaries together; open segments run through `now`, while reports exclude reconnecting.
- The stale sweep compare-and-sets state and `lastEventAt`; weakening that guard can overwrite a fresh event.
- Prisma `P2034`/`P2002` can reflect serializable/live-session-index races and are intentionally retried by [`SessionService`](../../src/services/session-service.ts:37).
- Discord error 10008 triggers intentional message recreation; configured channel migration also replaces/moves session messages.
- Bloxlink mappings cache for 24 hours and cached data is returned when lookup fails.
- Diagnose, but do not endorse, the launch mismatch: [`Dockerfile`](../../Dockerfile) uses `dist/src/index.js`, while `npm start` in [`package.json`](../../package.json) points to `dist/index.js`.
