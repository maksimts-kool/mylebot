# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Workflow
- Requires Node 24; install reproducibly with `npm ci` and regenerate Prisma after schema changes with `npm run prisma:generate`.
- Run one test file with `npx vitest run tests/api.test.ts`; target one case with `npx vitest run tests/api.test.ts -t "accepts an authenticated event"`.
- Before finishing, run `npm test`, `npm run typecheck`, and `npm run build`.
- This is NodeNext ESM: TypeScript imports local modules using emitted `.js` extensions.

## Architecture and invariants
- `roblox/` emits authenticated presence batches; `src/api.ts` validates them; `SessionService` owns the state machine and persistence; the Discord publisher and commands are projections/admin interfaces.
- Preserve `ACTIVE|INACTIVE -> RECONNECTING -> ENDED`: reconnect time is tracked separately, and every transition closes the open segment before opening the next.
- Session counters are finalized elapsed time; open-segment reporting uses `endedAt ?? now`. Manual edits must keep active + inactive + reconnect equal to wall-clock duration.
- Event processing is idempotent by UUID and ordered by `lastEventAt`; keep it in serializable transactions with retries for Prisma `P2034`/`P2002`.
- A partial SQL index permits only one non-deleted live session per identity; it exists in the migration, not the Prisma schema.
- A valid event below `ROBLOX_MIN_RANK` is an intentional hard purge of identity, sessions, audits, processed events, and published Discord messages; ranks above the configured maximum are merely rejected.
- Session removal from Discord is soft deletion (`deletedAt`) plus an audit entry; live sessions cannot be manually edited or removed.
- Calendar reports and manual local dates use `REPORT_TIMEZONE`; do not replace their Luxon/Intl boundary handling with host-local dates.
- Roblox IDs cross JSON as decimal strings and become `bigint`; never serialize JavaScript bigints directly.
- Keep the Roblox sender's batch size (currently 100) compatible with `MAX_BATCH_SIZE`, and preserve lifecycle events over heartbeats when its queue is full.
- Discord command definitions are synchronized to the configured guild at startup; command-shape changes also require `npm run commands:deploy` when deployment is performed separately.
