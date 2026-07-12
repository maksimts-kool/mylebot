# Repository Guide for Coding Agents

This file is the project-specific working agreement for `mylebot`. Read it before editing code. Keep changes focused, preserve the invariants below, and use the repository as the source of truth when this guide and the implementation differ.

## What this service does

`mylebot` tracks eligible Roblox group members' play sessions in PostgreSQL and projects that state into Discord.

The data flow is:

1. [`roblox/`](roblox/) observes player presence and sends authenticated event batches.
2. [`src/api.ts`](src/api.ts) authenticates and validates ingestion requests.
3. [`src/services/session-service.ts`](src/services/session-service.ts) owns lifecycle transitions, accounting, idempotency, and persistence.
4. [`src/discord/publisher.ts`](src/discord/publisher.ts) publishes session state; [`src/discord/commands.ts`](src/discord/commands.ts) provides reporting and administration.

Discord is a projection and administration surface, not the source of session truth. Do not move lifecycle rules into API routes, jobs, or Discord handlers.

## Start here

Before changing code:

- Check `git status` and preserve unrelated work.
- Read the implementation, its callers, and the relevant tests before editing.
- Use Node.js 24 or newer and install reproducibly with `npm ci` when dependencies are not already present.
- Review [`README.md`](README.md) for configuration, deployment, and user-facing behavior.
- Do not commit, push, change branches, deploy commands, or apply production migrations unless explicitly requested.

Useful entry points:

| Area | Source | Tests |
| --- | --- | --- |
| Configuration and environment validation | [`src/config.ts`](src/config.ts) | API and service tests |
| HTTP ingestion and health checks | [`src/api.ts`](src/api.ts) | [`tests/api.test.ts`](tests/api.test.ts), [`tests/session-validation.test.ts`](tests/session-validation.test.ts) |
| Session lifecycle | [`src/services/session-service.ts`](src/services/session-service.ts) | [`tests/session-validation.test.ts`](tests/session-validation.test.ts) |
| Time accounting and reports | [`src/domain/accounting.ts`](src/domain/accounting.ts), [`src/domain/reporting.ts`](src/domain/reporting.ts) | [`tests/accounting.test.ts`](tests/accounting.test.ts), [`tests/reporting.test.ts`](tests/reporting.test.ts) |
| Runtime configuration | [`src/services/runtime-settings.ts`](src/services/runtime-settings.ts) | [`tests/runtime-settings.test.ts`](tests/runtime-settings.test.ts) |
| Discord permissions and commands | [`src/discord/commands.ts`](src/discord/commands.ts) | [`tests/commands.test.ts`](tests/commands.test.ts) |
| Database model | [`prisma/schema.prisma`](prisma/schema.prisma), [`prisma/migrations/`](prisma/migrations/) | Service and API tests |
| Roblox producer | [`roblox/server/MainModule.lua`](roblox/server/MainModule.lua) | Manual/integration validation |

## Non-negotiable domain invariants

### Session lifecycle and accounting

- The lifecycle is `ACTIVE` / `INACTIVE` -> `RECONNECTING` -> `ENDED`.
- A valid join or heartbeat during the reconnect grace period resumes a reconnecting session as `ACTIVE` or `INACTIVE` rather than creating a new session.
- A join or heartbeat after the reconnect deadline first closes the expired session at its deadline, then may create or update the next session.
- Departures, shutdowns, and stale-heartbeat processing enter `RECONNECTING`; grace expiry ends the session.
- For every transition: close the open segment, add elapsed time to the state being left, update the session, then open the next segment when appropriate.
- Reconnecting time is retained for editing and wall-clock validation but excluded from report totals. Reports treat live sessions as ending at `endedAt ?? now`.
- Manual session edits must preserve `active + inactive + reconnecting == endedAt - startedAt`.
- Soft-deleted sessions must not participate in live-session queries or reports.

### Event processing and concurrency

- Event UUIDs are idempotency keys. A processed UUID must never apply its event twice.
- Process each batch in `lastEventAt` order so stale or reordered events cannot roll state backward.
- Lifecycle writes belong in serializable transactions. Preserve bounded retries for Prisma `P2034` and `P2002` conflicts.
- Stale-session and reconnect sweeps must re-check the state and timestamp/deadline they selected; do not overwrite a concurrent heartbeat or join.
- PostgreSQL permits only one non-deleted live session per identity through the partial unique index in [`prisma/migrations/20260711000200_live_session_invariant/migration.sql`](prisma/migrations/20260711000200_live_session_invariant/migration.sql). Prisma cannot express this index, so it is intentionally absent from `schema.prisma`.

### Eligibility and destructive behavior

- Tracking disabled in runtime settings short-circuits ingestion and sweep processing.
- Rank boundaries are inclusive.
- A source-valid event below the configured minimum rank intentionally hard-purges that identity, its sessions, audit records, processed events, and Discord references. It also removes published session messages.
- A rank above the configured maximum is rejected and must not trigger the purge.
- Changes to purge criteria or scope are destructive behavior changes. Call them out explicitly and add regression coverage.

### Identifiers, batches, and time

- Roblox IDs cross JSON boundaries as decimal strings. The API currently accepts decimal strings or JSON numbers and converts them to `bigint`; never serialize a native JavaScript `bigint`.
- Keep the Roblox producer batch size of 100 within backend `MAX_BATCH_SIZE`.
- Under sender queue pressure, discard replaceable heartbeats before lifecycle events such as join, activity change, leave, or shutdown.
- Timestamps are instants in storage and transport. Reporting boundaries and manual date input use the configured IANA `REPORT_TIMEZONE`; preserve DST-safe, half-open date ranges.

### Runtime settings and Discord

- Discord logs-channel and role settings are configured through `/config` and stored in PostgreSQL; they do not have environment fallbacks.
- Discord access is cumulative. Guild administrators have manager access; otherwise take the maximum permission level from database roles.
- Slash-command definitions synchronize at startup. When command shapes change, keep startup synchronization, [`scripts/deploy-commands.ts`](scripts/deploy-commands.ts), tests, and README documentation aligned.
- Discord publication failures must not become session state authority or corrupt persisted lifecycle state.

## Implementation conventions

- This is strict TypeScript with NodeNext ESM. Local TypeScript imports must use their emitted `.js` suffix.
- Preserve `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` behavior from [`tsconfig.json`](tsconfig.json); fix types instead of weakening the compiler configuration.
- Keep pure time/accounting/reporting logic in `src/domain/`, orchestration and persistence in `src/services/`, transport validation in `src/api.ts`, and Discord-specific behavior in `src/discord/`.
- Reuse existing Zod schemas, Prisma transaction patterns, and error conventions before introducing new abstractions.
- Validate at external boundaries: HTTP payloads, environment variables, Discord modal input, and external-service responses.
- Avoid broad catch blocks and silent recovery. Expected user errors should remain distinguishable from operational failures.
- Do not add a production dependency when the existing stack or a small local implementation is sufficient. Ask before adding a significant dependency.
- Never log or commit Discord tokens, Bloxlink keys, database credentials, Roblox ingestion secrets, raw authorization headers, or `.env` contents.

## Database and migrations

- After changing [`prisma/schema.prisma`](prisma/schema.prisma), run `npm run prisma:generate` and include the appropriate migration when storage behavior changes.
- Use `npm run prisma:migrate` only for a development database. Use `npm run prisma:deploy` only to apply already committed migrations to a deployment.
- Do not edit an already deployed migration casually. Add a new forward migration unless the migration is known to be unreleased.
- Review SQL migrations directly; the Prisma schema is not the complete database definition because of the live-session partial index.
- Treat hard deletes, column drops, backfills, uniqueness changes, and enum changes as high risk. Explain the compatibility and rollback implications before implementing them.
- Never run destructive or production database operations without explicit authorization and a backup/rollback plan.

## Testing strategy

Add or update the smallest test that proves the requested behavior. Bug fixes should include a regression test when the behavior is testable.

Focused commands:

```powershell
npx vitest run tests/api.test.ts
npx vitest run tests/api.test.ts -t "accepts an authenticated event"
npx vitest run tests/session-validation.test.ts
```

Before finishing code changes, run:

```powershell
npm test
npm run typecheck
npm run build
```

Also run `npm run prisma:generate` after schema changes. There is currently no separate lint or format script; do not claim those checks ran.

Choose additional validation based on the affected surface:

- API changes: authentication order, payload limits, invalid/stale inputs, and response status/body.
- Lifecycle changes: duplicate and out-of-order events, deadline boundaries, concurrent sweeps, and all state transitions.
- Reporting changes: open sessions, deleted sessions, reconnect exclusion, timezone boundaries, and DST changes.
- Discord changes: permission levels, command definitions, empty/error states, and message update/delete behavior.
- Roblox changes: every allowed place, queue overflow behavior, shutdown flushing, and backend batch compatibility.
- Deployment changes: Compose interpolation, health/readiness behavior, secret handling, and migration order.

Documentation-only changes do not require the full test suite, but links, commands, and the final diff must still be reviewed.

## Keeping changes complete

When behavior changes, update all affected layers together:

- implementation and types;
- focused regression tests;
- Prisma schema and migrations when persistence changes;
- Roblox producer and backend validation when the wire contract changes;
- Discord command definitions and deployment synchronization when command shapes change;
- `.env.example`, Compose/Portainer configuration, and [`README.md`](README.md) when setup or operations change.

Before handing off, inspect `git diff` for unrelated churn, debug output, generated secrets, accidental lockfile changes, and missing tests or documentation. Report exactly what changed, which checks actually passed, any skipped validation, and only repository-specific follow-ups that remain.
