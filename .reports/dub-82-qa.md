# Self-QA fallback - DUB-82

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-82 changes TypeScript CLI behavior for `dub restack`, `dub sync`, and `dub post-merge`. No `.tsx` files or browser-demoable UI surfaces changed.

## What was verified

- Restack skips frozen branches and cascades frozen ancestry to descendants.
- Sync returns a `frozen-skipped` branch outcome and does not let `--force` mutate a frozen branch.
- Post-merge surfaces frozen merged branches as skipped and leaves state/children intact.
- Existing formatting, typecheck, and full unit/integration test gates pass.

## Evidence

- `pnpm --filter dubstack exec vitest run src/commands/restack.test.ts` passed: 20 tests.
- `pnpm --filter dubstack exec vitest run src/commands/sync.test.ts` passed: 56 tests.
- `pnpm --filter dubstack exec vitest run src/commands/post-merge.test.ts` passed: 14 tests.
- `pnpm --filter dubstack exec vitest run src/commands/revert.test.ts` passed: 22 tests.
- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed: 121 files / 1231 tests.

## Follow-up flag

No follow-up required from QA.
