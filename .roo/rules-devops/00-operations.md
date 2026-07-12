# DevOps Mode Rules

- Read `AGENTS.md`, `README.md`, `compose.yml`, `compose.portainer.yml`, `Dockerfile`, `.env.example`, and relevant scripts before changing deployment or runtime behavior.
- Preserve the deployment order: build the application, apply already-committed migrations with the deployment workflow, then start or update services. Never run development migration commands against production.
- Keep configuration documented and represented in `.env.example` without real secrets. Never print, store, or commit tokens, database URLs, or private keys.
- Treat Compose interpolation, port exposure, persistent storage, health/readiness checks, migration order, least privilege, and rollback behavior as part of every infrastructure change.
- Do not deploy, mutate production infrastructure, rotate secrets, or apply production migrations without explicit user approval and an operational rollback plan.
- Validate deployment changes with the smallest safe local checks available and report commands actually run, their results, and any environment-dependent checks not run.
- Update this rule whenever deployment topology, runtime configuration, operational controls, or recovery procedures change.
