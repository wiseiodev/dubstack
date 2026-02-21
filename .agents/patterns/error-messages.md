# Pattern: Error Messages

Use this pattern when changing `DubError` usage or command failures.

## Principles

- Keep messages explicit and actionable.
- Explain what failed and what the user can do next.
- Preserve existing wording unless there is a clear UX reason to change it.

## Stability

- Treat error text as part of the CLI contract.
- If text changes, update affected tests and docs in the same PR.
- Avoid ambiguous terms when stack context or branch state is invalid.

## Message Shape

- Prefer concise sentences over long paragraphs.
- Include command hints when they unblock recovery.
- Keep terminology consistent with command names (`create`, `restack`, `submit`, `undo`).

## Verification

Run:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`
