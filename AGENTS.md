# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Workflow
- Requires Node 24 or newer; install reproducibly with `npm ci`.
- After changing [`prisma/schema.prisma`](prisma/schema.prisma), run `npm run prisma:generate`.
- Run [`npx vitest run tests/api.test.ts`](tests/api.test.ts); target one case with [`npx vitest run tests/api.test.ts -t "accepts an authenticated event"`](tests/api.test.ts).
- Before finishing code work, run `npm test`, `npm run typecheck`, and `npm run build`.
- Strict NodeNext ESM requires emitted `.js` suffixes on local TypeScript imports; preserve exact optional and unchecked-index handling configured in [`tsconfig.json`](tsconfig.json).

## Invariants
- [`roblox/`](roblox/) emits authenticated batches, [`src/api.ts`](src/api.ts) validates them, [`SessionService`](src/services/session-service.ts:37) owns lifecycle persistence, and Discord is a projection/admin surface.
- ACTIVE/INACTIVE may enter RECONNECTING; during grace, join/heartbeat may resume ACTIVE/INACTIVE. ENDED occurs at grace expiry or closure by post-deadline processing. Close the open segment, account the prior state, then open the next; reports use `endedAt ?? now` and exclude reconnecting, while edits retain reconnect time and wall-clock equality.
- Process UUIDs idempotently and order by `lastEventAt` in serializable transactions retried for Prisma `P2034`/`P2002`.
- The PostgreSQL-only partial index in [`migration.sql`](prisma/migrations/20260711000200_live_session_invariant/migration.sql) permits one non-deleted live session per identity; it is absent from [`prisma/schema.prisma`](prisma/schema.prisma).
- Tracking-disabled short-circuits. A source-valid below-minimum rank hard-purges identity, sessions, audits, processed events, and Discord references; above-maximum rank rejects.
- Producers emit Roblox IDs as decimal strings; the [`src/api.ts`](src/api.ts) schema currently accepts decimal strings or JSON numbers and converts them to `bigint`. Never serialize native bigints.
- Keep the Lua batch of 100 within `MAX_BATCH_SIZE`, dropping heartbeats before lifecycle events under queue pressure.
- PostgreSQL runtime settings override environment fallbacks; Discord permissions take the maximum of database role levels and legacy environment role IDs.
- Slash commands synchronize at startup; keep command definitions and deployment behavior aligned when their shape changes.
