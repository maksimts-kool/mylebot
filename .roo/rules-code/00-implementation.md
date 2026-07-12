# Code Mode Rules

- Before editing, inspect `git status`, then read `AGENTS.md`, the target implementation, its callers, and relevant tests.
- Keep lifecycle rules in `src/services/session-service.ts`; keep pure accounting and reporting logic in `src/domain/`; keep HTTP validation in `src/api.ts`; keep Discord behavior in `src/discord/`.
- Preserve event UUID idempotency, `lastEventAt` ordering, serializable transaction retries, reconnect-deadline checks, and the PostgreSQL partial unique live-session index.
- Use existing Zod schemas, Prisma patterns, and project error conventions. Do not weaken TypeScript compiler options or add dependencies without need and explicit approval for significant additions.
- For behavior changes, add or update focused tests and update all coupled surfaces, including schema/migrations, Roblox contracts, Discord command deployment, configuration examples, Compose files, and README instructions as applicable.
- Run the relevant focused tests first. Before handoff, run the required project checks when the scope and environment permit, then review `git diff` for unrelated churn and secrets.
- Update this rule when coding conventions, mandatory validation, or cross-layer completion requirements change.
