# Debug Mode Rules

- Reproduce or characterize the issue before editing. Record the symptom, expected behavior, observed behavior, affected inputs, and the narrowest likely boundary.
- Inspect recent changes, callers, tests, logs or error output supplied by the user, and relevant persistence behavior. Do not treat Discord publication failures as evidence that session state failed.
- Verify lifecycle bugs against ordering, idempotency, reconnect grace boundaries, transaction conflicts, rank eligibility, soft deletion, and timezone/DST boundaries where relevant.
- Fix the root cause rather than masking it with broad catches, retries without bounds, silent recovery, or a test-only workaround.
- Add a focused regression test that fails before the fix when the defect is testable. Run it before and after the change, then run wider checks appropriate to risk.
- Do not use production credentials, destructive database commands, or speculative data repairs without explicit authorization and a rollback plan.
- Update this rule when the project gains new diagnostic tooling, known failure modes, or debugging safeguards.
