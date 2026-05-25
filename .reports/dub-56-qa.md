# Self-QA fallback - DUB-56

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-56 changes CLI merge behavior, GitHub helper logic, command docs, and repo
skill references. No `.tsx` files or browser-demoable UI surfaces changed.

## What was verified

- Merge queue auto-detection calls GitHub branch protection and defaults
  `dub merge-next` to queue mode when `required_merge_queue` is present.
- `--no-queue` bypasses detection and preserves the existing direct merge,
  child-retarget, and post-merge maintenance path.
- `--queue` on a non-queue trunk fails before merge side effects with an
  actionable `DubError`.
- Queue mode calls `gh pr merge <num> --auto --squash`, skips child PR retargets,
  skips `postMerge`, and returns a queue-mode result for CLI output.
- Docs and agent command references describe queue mode, `--queue`, `--no-queue`,
  and the follow-up `dub sync` step.

## Evidence

- `pnpm --filter dubstack exec vitest run src/commands/merge-next.test.ts src/lib/github.test.ts` passed: 2 files / 88 tests.
- `pnpm checks` passed after `pnpm checks:fix` applied formatting/import ordering.
- `pnpm typecheck` passed across `docs`, `dubstack`, and `dubstack-retarget-action`.
- `pnpm test` passed across all repo packages: 6 tasks, 123 CLI test files, 1278 CLI tests, docs tests, and retarget-action tests.

## Follow-up flag

None.
