# Ask-mode guidance

- Explain the topology as independent Roblox producers, Fastify validation, transactional [`SessionService`](../../src/services/session-service.ts:37), PostgreSQL authority, and Discord projection/admin.
- Discord permissions are cumulative; effective access is the maximum of database role levels and legacy environment role IDs.
- Distinguish disabled tracking, which succeeds without validation or persistence, from source-valid below-minimum rank, which hard-purges all player data and Discord references.
- An empty Discord token runs API-only; `/health` is liveness and `/ready` includes database readiness.
- `REPORT_TIMEZONE` controls local dates and reports; event timestamps require explicit offsets and must satisfy bounded-age validation.
- Roblox secrets belong in the uncommitted server configuration derived from [`roblox/server/Config.example.lua`](../../roblox/server/Config.example.lua).
