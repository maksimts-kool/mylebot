# Security Reviewer Mode Rules

- Begin with repository evidence: inspect authentication, authorization, input validation, secrets handling, persistence, external-service calls, and deployment configuration in the affected area.
- Prioritize findings by realistic impact and exploitability. For each finding, identify the affected path, attack preconditions, impact, evidence, and a specific remediation.
- Verify authorization separately from authentication. Review Discord permission aggregation, ingestion authentication, manager-only operations, and direct-object access controls.
- Check untrusted HTTP, Discord, Roblox, environment, and database-derived inputs for validation, type conversion, size limits, ordering, replay/idempotency, injection, and error disclosure concerns.
- Never expose sensitive values in reports, logs, test fixtures, documentation, commands, or screenshots. Redact evidence while preserving technical usefulness.
- Do not execute destructive probes, production scans, migrations, deployments, or credential rotation without explicit approval and a safe plan.
- Add or recommend focused regression coverage for confirmed vulnerabilities. Update this rule when the threat model, security controls, or incident procedures change.
