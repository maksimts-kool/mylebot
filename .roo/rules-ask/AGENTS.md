# Ask-mode guidance

- Describe the system as a Roblox event producer, Fastify ingestion boundary, transactional session state machine, PostgreSQL source of truth, and Discord projection/admin surface.
- Permission levels are cumulative: everyone 1, staff 2, admin 3, manager 4; Discord Administrator maps to manager, database role settings combine with legacy environment role IDs by maximum level.
- Tracking disabled returns successful per-event `tracking_disabled` results without validation or persistence. Below-minimum rank events instead permanently purge that player's stored data and Discord messages.
- `/health` is liveness; `/ready` includes database readiness. PostgreSQL is internal-only in the default Compose stack, while the API binds to host loopback by default.
- Reports and local manual timestamps follow `REPORT_TIMEZONE`; event timestamps themselves must be offset-bearing ISO strings and within the configured age window.
- Roblox server configuration is a manually created, gitignored `Config.lua`; the ingestion secret must match the backend and must not be committed.
