# Pattern: Command Changes

Use this pattern when modifying files under `src/commands/*`.

## 1) Start With Existing Flow

- Read the target command and supporting helpers in `src/lib/*`.
- Keep argument and flag behavior backward compatible unless change is intentional.

## 2) Keep UX Stable

- Treat command text and `DubError` strings as part of UX contract.
- If text changes, update tests that assert output.

## 3) Protect Stack Invariants

- Ensure stack context is validated before mutating state.
- Preserve submit linearity constraints during submit workflows.
- Preserve the multi-level `undo`/`redo` ring buffer contract (20 entries, mutating commands save before mutation, new mutations clear the redo log); don't shrink coverage without a scoped change.

## 4) Test Nearby

- Update command unit tests in `src/commands/*.test.ts`.
- Add cross-command coverage in `test/**/*.test.ts` when behavior spans multiple commands.

## 5) Verify Before Merge

Run:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`
