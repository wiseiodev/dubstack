# Pattern: Testing

Use this pattern when behavior, UX text, or stack state logic changes.

## Coverage Priorities

- Command behavior in `src/commands/*.test.ts`.
- Shared helpers in `src/lib/*.test.ts`.
- End-to-end command interactions in `test/**/*.test.ts`.

## What To Assert

- User-facing command output and error messages when they are part of UX.
- Stack state transitions and parent/child relationships after mutations.
- Submit and restack edge paths (invalid context, conflicts, recovery).

## Test Design

- Keep tests deterministic and minimal.
- Prefer narrow tests that isolate one behavior per case.
- Add regression tests for every fixed bug.

## Required Verification

Run all of the following from repo root:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`

Do not mark work complete unless all three pass.
