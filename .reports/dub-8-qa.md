# Self-QA fallback - DUB-8

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-8 changes TypeScript CLI behavior only. No `.tsx` files or browser-demoable UI paths changed.

## What was verified

- Worktree checkout discovery returns only branches checked out outside the current worktree.
- `dub sync` reports `checked-out-elsewhere` and avoids branch reconciliation/deletion for those branches.
- `dub restack` skips rebasing a branch checked out in another worktree.
- `dub post-merge` skips cleanup for merged branches checked out in another worktree.
- Required repository gates passed.

## Evidence

- `pnpm --filter dubstack exec vitest run src/lib/git.test.ts src/commands/restack.test.ts src/commands/sync.test.ts src/commands/post-merge.test.ts`
- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`

## Follow-up flag

None.
