# Architect-mode guidance

- Keep `SessionService` as the sole owner of lifecycle transitions; API, timers, Discord publishing, and commands should orchestrate rather than duplicate state-machine logic.
- PostgreSQL invariants complement Prisma: the partial unique index guarantees one non-deleted live session per identity and must be preserved through migration design.
- Model delivery as at-least-once and potentially out-of-order. Event UUID deduplication, `lastEventAt` ordering, serializable transactions, and retry handling are architectural safeguards, not incidental implementation.
- Timing has coupled historical segments and denormalized bigint counters; any redesign must preserve exact wall-clock accounting, including reconnect grace time and currently open segments.
- Rank loss below the minimum is a privacy/data-lifecycle boundary requiring hard deletion across identities, sessions, audits, processed events, and Discord projections.
- Runtime settings and permission roles live in PostgreSQL; environment role/channel values are bootstrap or legacy fallbacks, not the only configuration source.
- Roblox producers run independently in every universe place, buffer transient failures, favor lifecycle events over heartbeats under pressure, and must remain batch-compatible with the API limit.
