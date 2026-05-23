# Self-QA fallback - DUB-5

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

The change is in the git library (`packages/cli/src/lib/git.ts`) — there is no UI surface to record. The behavior under test is `git push --force-with-lease` semantics against a bare git remote, which produces no visible UI.

## What was verified

Two new unit tests in `packages/cli/src/lib/git.test.ts` (under `describe('pushBranch')`) execute real git pushes against a bare remote in a temp directory and assert the exact behavior the issue requires:

1. **`lease succeeds when our tracked SHA matches reality on remote`** — Pushes a feature branch (records the tracked SHA via `refs/dubstack/last-pushed/feat/lease`), adds a second commit locally, pushes again, asserts the second push succeeds, the tracked ref is updated to the new SHA, and the remote ref matches.

2. **`refuses with a lease error when a third party pushed concurrently`** — Pushes a feature branch (records the tracked SHA), then a second working tree clones the bare remote and pushes its own commit to the same branch. The first working tree advances its branch locally and a `git fetch origin <branch>` is run (simulating an IDE background fetch updating `refs/remotes/origin/<branch>`). Asserts `pushBranch` throws a `DubError` whose message starts with `"refused: remote has updates not reflected in our last-pushed ref"`, whose recovery hints include `dub sync`, and that the tracked ref is unchanged after the failure (so retry-after-sync works).

A third test (`pushes and records the last-pushed SHA on first push`) confirms a fresh push records the tracked ref and matches the remote.

Lint, typecheck, and the full 503-test suite all pass.

## Evidence

- `packages/cli/src/lib/git.test.ts` — 3 new tests added under `describe('pushBranch')` and one under `describe('lastPushedRef')`. All pass:
  - `npx vitest run src/lib/git.test.ts` → 37/37 passed
- `pnpm checks` → biome clean (188 files)
- `pnpm typecheck` → 2 packages clean
- `pnpm test` → 68 files / 503 tests passed

## Follow-up flag

First-push protection is intentionally degraded: with no tracked SHA yet, `pushBranch` falls back to bare `--force-with-lease`, which leases against `refs/remotes/origin/<branch>` and is vulnerable to the same background-fetch race for that very first push only. Subsequent pushes are fully protected once the tracking ref is recorded. The spec does not require first-push protection; this gap could be addressed in a follow-up if the threat model expands.
