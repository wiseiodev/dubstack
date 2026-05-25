# Adversarial Review - DUB-53

Target: staged diff for DUB-53.
Focus: submit flow correctness, GitHub CLI safety, command UX, and tests.

## Findings

### Major - fixed

`--method` could be passed without `--merge-when-ready` and would be ignored.
The first implementation also registered a Commander default, which made it
impossible to distinguish an omitted method from an explicit one.

Fix:
- Removed the Commander default for `--method`.
- Added a `DubError` guard in `submit()` requiring `--merge-when-ready` when
  `method` is provided.
- Added regression coverage for `--method` without `--merge-when-ready`.

## Remaining Findings

No remaining critical or major findings.

Minor residual risk: GitHub's exact disabled-auto-merge error wording can vary
by repository settings. The implementation preserves GitHub's raw message and
adds recovery hints for branch protection / repository auto-merge setup.

## Verification After Fix

- `pnpm --filter dubstack exec vitest run src/commands/submit.test.ts src/lib/github.test.ts`
- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`
