# Code-mode guidance

- Preserve NodeNext emitted `.js` suffixes on local imports and the exact-optional/unchecked-index constraints in [`tsconfig.json`](../../tsconfig.json).
- Keep [`SessionService`](../../src/services/session-service.ts:37) transitions atomic: close the segment, account the prior state, open the next, and update timestamps in one serializable transaction.
- Preserve ingestion outcomes: tracking-disabled short-circuits; below-minimum rank hard-purges; above-maximum rejects; duplicate UUIDs are no-ops; older events do not mutate current state.
- The one-live-session invariant comes from the PostgreSQL partial index in [`migration.sql`](../../prisma/migrations/20260711000200_live_session_invariant/migration.sql), not [`prisma/schema.prisma`](../../prisma/schema.prisma).
- Completed-session edits retain reconnect duration, audits, and wall-clock equality. Producers emit Roblox IDs as decimal strings; the [`src/api.ts`](../../src/api.ts) schema currently accepts decimal strings or JSON numbers and converts them to `bigint`. Never serialize native bigints.
- Keep the Lua batch of 100 within the API limit and preserve lifecycle events over heartbeats under queue pressure.
- Keep slash-command definitions, startup synchronization, and [`scripts/deploy-commands.ts`](../../scripts/deploy-commands.ts) aligned when command shape changes.
