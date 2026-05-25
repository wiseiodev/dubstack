# Adversarial Review - DUB-82

## Scope

Reviewed staged diff for frozen-branch enforcement across `dub restack`, `dub sync`, `dub post-merge`, docs, and regression tests.

## Findings

### Fixed Before Commit

- Major: `dub sync` initially allowed recently-synced frozen branches to take the freshness-cache path, producing `fresh` instead of `frozen-skipped`. Fixed by forcing frozen branches out of the fresh-cache skip set and adding a regression test.

### Fixed From Copilot Review

- Minor: frozen sync branches were classified after remote/local SHA lookups, ancestry checks, and PR sync lookup. Fixed by short-circuiting to `frozen-skipped` before those probes and excluding frozen branches from the fetch list.
- Minor: numeric-hex `dub revert` fallback used commit-not-found message equality and could replace likely-SHA guidance with PR-not-found guidance. Fixed with typed internal errors and a regression test that rethrows the original commit-resolution error when the fallback PR is missing.

## Remaining Findings

- Critical: 0
- Major: 0
- Minor: 0
- Nitpick: 0

## Evidence After Fix

- `pnpm checks` passed.
- `pnpm --filter dubstack exec vitest run src/commands/sync.test.ts` passed: 56 tests.
- `pnpm --filter dubstack exec vitest run src/commands/revert.test.ts` passed: 23 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed: 121 files / 1232 tests.
