# Repository Guide for Coding Agents

This file is the project-specific working agreement for `mylebot`. Read it before editing code. Keep changes focused, preserve the invariants below, and use the repository as the source of truth when this guide and the implementation differ.

## What this service does

`mylebot` is a Discord bot built from independent feature modules. Its first and largest feature tracks eligible Roblox group members' play sessions in PostgreSQL and projects that state into Discord; others integrate the store-owners portal and the Taiga board.

The session data flow is:

1. [`roblox/`](roblox/) observes player presence and sends authenticated event batches.
2. [`src/features/sessions/api/routes.ts`](src/features/sessions/api/routes.ts) authenticates and validates ingestion requests.
3. [`src/features/sessions/service/session-service.ts`](src/features/sessions/service/session-service.ts) owns lifecycle transitions, accounting, idempotency, and persistence.
4. [`src/features/sessions/discord/publisher.ts`](src/features/sessions/discord/publisher.ts) publishes session state; [`src/features/sessions/discord/commands/`](src/features/sessions/discord/commands/) provides reporting and administration.

Discord is a projection and administration surface, not the source of session truth. Do not move lifecycle rules into API routes, jobs, or Discord handlers.

## Feature architecture

Code belongs to exactly one of three layers:

- `src/core/` — configuration, database client, HTTP server, Discord client, scheduler, and the `Feature` contract. Core must never import from `src/features/`.
- `src/shared/` — services more than one feature needs (Bloxlink, runtime settings, permission levels, reusable Discord components).
- `src/features/<name>/` — one self-contained slice, with `domain/` (pure), `service/` (orchestration and persistence), `api/` (transport), `discord/` (gateway surface), and an `index.ts` exporting `create<Name>Feature(ctx): Feature`.

A feature declares its routes, slash commands, background jobs, and lifecycle hooks through the `Feature` object; [`src/index.ts`](src/index.ts) only composes them. When adding a feature:

- Register it in [`src/index.ts`](src/index.ts) and in [`src/features/command-data.ts`](src/features/command-data.ts), which is what `scripts/deploy-commands.ts` deploys. Keep the two gated identically so a manual deploy cannot install a command the running bot ignores.
- Namespace every component `customId` with the feature name. Features share the `interactionCreate` event, so each handler must ignore interactions it does not own.
- Return `null` from the factory when the feature is not configured, rather than half-registering it.
- Features must not import from each other. Promote anything genuinely shared into `src/shared/`.

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
| Configuration and environment validation | [`src/core/config.ts`](src/core/config.ts) | API and service tests |
| HTTP server, health checks, error contract | [`src/core/http.ts`](src/core/http.ts) | [`tests/sessions/api.test.ts`](tests/sessions/api.test.ts) |
| Feature contract and composition | [`src/core/feature.ts`](src/core/feature.ts), [`src/index.ts`](src/index.ts) | — |
| Roblox event ingestion | [`src/features/sessions/api/routes.ts`](src/features/sessions/api/routes.ts) | [`tests/sessions/api.test.ts`](tests/sessions/api.test.ts), [`tests/sessions/session-validation.test.ts`](tests/sessions/session-validation.test.ts) |
| Session lifecycle | [`src/features/sessions/service/session-service.ts`](src/features/sessions/service/session-service.ts) | [`tests/sessions/session-validation.test.ts`](tests/sessions/session-validation.test.ts) |
| Time accounting and reports | [`src/features/sessions/domain/`](src/features/sessions/domain/) | [`tests/sessions/accounting.test.ts`](tests/sessions/accounting.test.ts), [`tests/sessions/reporting.test.ts`](tests/sessions/reporting.test.ts) |
| Runtime configuration | [`src/shared/runtime-settings.ts`](src/shared/runtime-settings.ts) | [`tests/shared/runtime-settings.test.ts`](tests/shared/runtime-settings.test.ts) |
| Discord permissions | [`src/shared/permissions.ts`](src/shared/permissions.ts) | [`tests/sessions/commands.test.ts`](tests/sessions/commands.test.ts) |
| Session commands | [`src/features/sessions/discord/commands/`](src/features/sessions/discord/commands/) | [`tests/sessions/commands.test.ts`](tests/sessions/commands.test.ts) |
| Store-owners portal endpoints | [`src/features/portal/`](src/features/portal/) | [`tests/portal/site-notify.test.ts`](tests/portal/site-notify.test.ts) |
| Taiga board integration | [`src/features/taiga/`](src/features/taiga/) | [`tests/taiga/`](tests/taiga/) |
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

### Taiga integration

- The board is the source of truth for a card's column; the forum post is the projection. `data.status` on a webhook is authoritative — never derive state from `change.diff` alone, so a replayed delivery converges instead of drifting.
- Column and tag names live only in [`src/features/taiga/domain/mapping.ts`](src/features/taiga/domain/mapping.ts). An unknown column must leave the post untouched rather than guess a tag set.
- Deleting a card means "declined" in every column except `In game`, where it means the shipped card was cleared off the board and the post keeps its `Approved` tag.
- The bot flags a card row `deleting` before deleting the story in Taiga, so the webhook its own delete triggers is not read as somebody declining the post.
- Webhook deliveries are deduplicated on a hash of the raw body. A delivery is claimed before it is applied, so a partially failed delivery is repaired by the reconcile sweep, not by a retry.
- The reconcile sweep may only treat missing cards as deleted when the entire board was read successfully. Preserve that guard and its regression test; without it one failed API call declines every post.
- Nothing older than `TaigaSettings.activatedAt` is ever touched. The integration must never back-fill existing forum posts.
- Taiga `PATCH`/`PUT` requires the object's current `version`; read before writing if an edit path is ever added.

### Runtime settings and Discord

- Discord logs-channel and role settings are configured through `/config` and stored in PostgreSQL; they do not have environment fallbacks. Taiga's channel settings work the same way through `/taiga`; only credentials and hosts come from the environment.
- Message intents are privileged and are requested only when Taiga is configured. Do not add them unconditionally — an unconfigured deployment would fail to log in.
- Discord access is cumulative. Guild administrators have manager access; otherwise take the maximum permission level from database roles.
- Slash-command definitions synchronize at startup. When command shapes change, keep startup synchronization, [`scripts/deploy-commands.ts`](scripts/deploy-commands.ts), tests, and README documentation aligned.
- Discord publication failures must not become session state authority or corrupt persisted lifecycle state.

## Implementation conventions

- This is strict TypeScript with NodeNext ESM. Local TypeScript imports must use their emitted `.js` suffix.
- Preserve `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` behavior from [`tsconfig.json`](tsconfig.json); fix types instead of weakening the compiler configuration.
- Within a feature, keep pure logic in `domain/`, orchestration and persistence in `service/`, transport validation in `api/`, and Discord-specific behavior in `discord/`. Prefer putting new logic in `domain/` where it can be unit tested without a client or a database.
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
npx vitest run tests/sessions/api.test.ts
npx vitest run tests/sessions/api.test.ts -t "accepts an authenticated event"
npx vitest run tests/sessions/session-validation.test.ts
npx vitest run tests/taiga
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
