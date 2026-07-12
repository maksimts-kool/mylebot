# mylebot: Shared Roo Code Rules

## Source of truth and scope

- Read `AGENTS.md` and the relevant implementation, callers, tests, and `README.md` before proposing or making a change.
- Treat the repository and its tests as the source of truth. If documentation conflicts with the implementation, identify the discrepancy and update the documentation in the same change when appropriate.
- Preserve unrelated working-tree changes. Inspect `git status` before editing and inspect `git diff` before handoff.
- Keep changes minimal, cohesive, and within the requested scope. Do not commit, push, switch branches, deploy, or run production migrations without explicit approval.

## Domain safety

- The session service is the authority for session lifecycle, accounting, idempotency, and persistence. Discord is a projection and administration surface only.
- Preserve the lifecycle and accounting invariants in `AGENTS.md`, including reconnect handling, event ordering, serializable lifecycle writes, and the one-live-session PostgreSQL invariant.
- Treat purge-criteria changes, hard deletes, schema changes, migrations, and production database operations as high risk. State impact and rollback considerations before making such a change.
- Never expose or commit credentials, tokens, ingestion secrets, raw authorization headers, or `.env` contents.

## Engineering and validation

- Preserve strict TypeScript and NodeNext ESM conventions. Local TypeScript imports use emitted `.js` suffixes.
- Validate external input at its boundary and reuse existing schemas, transaction patterns, and error conventions.
- Add the smallest focused regression test for behavior changes when practical. Run checks appropriate to the affected surface; report only checks that actually passed and any that were skipped.
- Update tests, documentation, configuration examples, deployment files, command deployment definitions, and producer/backend contracts together whenever the behavior requires it.

## Rule maintenance

- These rules are living project documentation. When a durable workflow, architecture, deployment, security, test, or documentation practice changes, update the applicable file in `.roo/rules/` or `.roo/rules-<mode>/` in the same pull request.
- Keep shared, cross-mode requirements here. Put instructions that only apply to one mode in that mode's directory to avoid duplication and conflicts.
