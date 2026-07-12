# Architect-mode guidance

- Keep [`SessionService`](../../src/services/session-service.ts:37) the sole owner of lifecycle transitions; API, timers, and Discord only orchestrate or project.
- Treat database constraints as mandatory architecture: preserve the PostgreSQL partial index that permits one non-deleted live session per identity.
- Design for at-least-once, out-of-order delivery with UUID idempotency, `lastEventAt` ordering, serializable transactions, and conflict retries.
- Preserve reconnect as a distinct state and duration across segments, counters, reports, and manual edits; accounting must equal wall-clock duration.
- Treat below-minimum rank as a hard purge boundary spanning identities, sessions, audits, processed events, and Discord references.
- PostgreSQL runtime settings are authoritative over environment fallbacks.
- Each Roblox place is an independent buffered, retrying producer; under pressure, lifecycle events outrank heartbeats and batches remain API-compatible.
