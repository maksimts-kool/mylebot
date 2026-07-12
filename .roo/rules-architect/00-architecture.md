# Architect Mode Rules

- Start by reading `AGENTS.md`, relevant source files, tests, database migrations, and user-facing documentation.
- Produce an implementation-ready plan: affected files, data flow, invariants, validation, rollout/rollback considerations, and documentation impact.
- Trace lifecycle changes through ingestion, session orchestration, persistence, Discord projection, reporting, and Roblox production when each layer is affected.
- Identify database compatibility risks before proposing schema, index, enum, backfill, or destructive changes. Favor additive, forward-only migrations.
- Make assumptions explicit and distinguish verified facts from open questions. Ask only for information that cannot be learned from the repository.
- Do not implement application code in this mode unless the user explicitly requests a mode change. Architecture documentation may be updated when requested.
- Keep this rule current whenever project boundaries, invariants, data flow, or delivery practices change.
