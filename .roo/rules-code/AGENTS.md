# Code-mode guidance

- Use NodeNext ESM `.js` suffixes for local TypeScript imports; strict options include `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Keep session state changes atomic: close the current `TimeSegment`, increment the prior state's counter, open the next segment, and update state timestamps in one serializable transaction.
- Preserve ingestion distinctions: below-minimum rank hard-purges all player data/messages, above-maximum rank rejects, duplicate UUIDs are no-ops, and out-of-order events are recorded without changing state.
- The one-live-session rule is enforced by the partial index in `prisma/migrations/20260711000200_live_session_invariant/migration.sql`; Prisma schema edits alone cannot represent it.
- Manual completed-session mutations must retain audit entries and satisfy active + inactive + reconnect = end - start; live sessions remain immutable through Discord controls.
- Treat Roblox IDs as `bigint` internally and decimal strings over JSON. Keep the Lua sender's hard-coded batch of 100 no larger than backend `MAX_BATCH_SIZE`.
- If slash-command definitions change, keep runtime guild synchronization and `scripts/deploy-commands.ts` behavior aligned.
