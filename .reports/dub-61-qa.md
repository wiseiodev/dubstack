# Self-QA fallback - DUB-61

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-61 changes TypeScript CLI branch-safety behavior only. No `.tsx` files or
browser-demoable surfaces changed, so the useful proof is command-level test
coverage and repo gates.

## What was verified

- A shared worktree guard refuses branch mutations before undo, journal, state,
  push, or PR side effects.
- Tier 3 commands `split`, `absorb`, `squash`, `fold`, `pop`, `rename`, `move`,
  `reorder`, and `unlink` refuse when their target branch is checked out in a
  sibling worktree.
- `submit` refuses before pushing when a branch in its resolved submit scope is
  checked out in a sibling worktree.
- The `DubError` recovery hints include the exact sibling worktree path.

## Evidence

- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed: 124 test files, 1354 tests.
- Focused regression coverage: `packages/cli/src/commands/worktree-guards.test.ts`
  passed all 11 scenarios using real git worktrees.

## Follow-up flag

None.
