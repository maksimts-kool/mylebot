# Debug-mode guidance

- Run a focused case with `npx vitest run tests/api.test.ts -t "accepts an authenticated event"`; tests use injected Fastify requests and Prisma-shaped mocks, not a live database.
- `/health` proves process liveness only; `/ready` executes `SELECT 1`, and Compose health checks the latter.
- Session timing defects usually involve three coupled representations: state timestamps, accumulated bigint counters, and `TimeSegment` boundaries. Open segments are calculated through `now`.
- Concurrent ingestion can surface Prisma `P2034` or `P2002`; `SessionService` retries both because the partial live-session index races with serializable transactions.
- A stale sweep rechecks both state and `lastEventAt` inside the transaction. Removing that compare-and-set guard can overwrite a fresh heartbeat.
- Missing Discord session messages (API error 10008) are recreated intentionally; a configured logs-channel change also moves/replaces messages.
- Bloxlink failures fall back to cached mappings, which are fresh for 24 hours, so stale identity display can outlive an upstream outage.
- The Docker entry point is `dist/src/index.js`; the package `start` script points at `dist/index.js` and is not equivalent to the container command.
