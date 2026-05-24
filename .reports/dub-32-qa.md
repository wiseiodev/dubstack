# Self-QA fallback - DUB-32

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub squash` is a CLI command that mutates local git state. No `.tsx` files
changed; there is no browser surface to record. Per the do-issue policy, CLI
work fills out `qa-fallback.md` instead of producing a Playwright video.

## What was verified

End-to-end smoke test against a freshly initialized DubStack repo at
`/tmp/dub-squash-smoke`, plus 10 unit/integration tests in
`packages/cli/src/commands/squash.test.ts`.

Scenarios exercised live:

1. **3-commit branch → 1 commit.** Created `feat/a` on `main`, made commits
   `feat: commit 1`, `feat: commit 2`, `feat: commit 3`, then ran `dub squash`.
   - Output: `✔ Squashed 3 commit(s) on 'feat/a' into one.` and
     `↳ Descendants restacked.`.
   - `git log main..feat/a` shows exactly one commit.
   - Commit body is the original messages concatenated most-recent-first
     (`feat: commit 3` then `feat: commit 2` then `feat: commit 1`).
2. **Single-commit no-op.** Re-ran `dub squash` on the now-1-commit branch.
   - Output: `Nothing to squash — 'feat/a' already has a single commit above 'main'.`
   - No state mutation.
3. **Dirty working tree refusal.** Added an untracked file and ran `dub squash`.
   - Errored with the documented "uncommitted changes" message and the
     recovery hint trio (`git status`, `git stash`, `dub modify -am`).
4. **`--help`** renders the description, both options, and three example lines.
5. **`--ai` + `-m` mutex.** Errored with
   `'--ai' cannot be combined with '-m'.` and the two-step recovery hint.

Automated coverage (`pnpm vitest run squash`):

1. `collapses N commits into one with concatenated messages and restacks descendants`
2. `is a no-op for a single commit`
3. `is a no-op for zero commits`
4. `-m overrides the auto-generated message`
5. `refuses to squash when the working tree is dirty`
6. `refuses on a branch without a tracked parent`
7. `rejects combining '--ai' with '-m'`
8. `refuses '--ai' when the AI assistant is disabled`
9. `uses the AI-generated message when '--ai' is supplied` (mocked AI deps)
10. `throws when the AI assistant returns an empty message under '--ai'`

## Evidence

- Unit suite: `packages/cli/src/commands/squash.test.ts` — 10/10 passing.
- Full test suite: `pnpm test` — 924/924 passing.
- Lint/format: `pnpm checks` — 0 errors across 301 files.
- Typecheck: `pnpm typecheck` — 2/2 packages clean.
- Smoke test commands recorded in turn output above; temp repo cleaned up after.

## Follow-up flag

None. The squash command, docs, and tests land complete; descendant restack
reuses the same `dub modify` conflict-recovery surface, so no new error path
needs follow-up tooling.
