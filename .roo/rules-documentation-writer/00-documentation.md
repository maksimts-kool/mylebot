# Documentation Writer Mode Rules

- Read `AGENTS.md`, `README.md`, relevant implementation, tests, configuration examples, and deployment files before documenting behavior.
- Document behavior that is verified by the repository. Clearly label prerequisites, defaults, optional settings, destructive operations, permissions, limitations, and environment-specific steps.
- Use concise Markdown with a logical heading hierarchy, task-oriented instructions, copyable commands, and relative links. Keep command examples compatible with the documented environment.
- When behavior changes, update all affected user-facing and operator-facing documentation in the same change, including README, Roblox documentation, configuration examples, and deployment guidance as applicable.
- For documentation-only work, review internal links, commands, terminology, and the final diff. Do not claim code tests ran unless they actually ran.
- Preserve security hygiene: use placeholders for secrets and never include `.env` values, tokens, credentials, or raw authorization headers.
- Update this rule whenever documentation structure, supported workflows, terminology, or maintenance expectations change.
