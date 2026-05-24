# Self-QA fallback - DUB-33

> This issue adds a CLI command (`dub fold`); no `.tsx` files changed and no
> browser UI exists for it. This file replaces the required video with
> deterministic proof from automated tests + tooling.

## Why no video

DUB-33 ships a Node CLI command, `dub fold`, that operates on git refs and
DubStack state. There is no rendered surface to record. The acceptance proof
is automated git-and-state observation in integration tests that drive a real
temporary repository.

## What was verified

Acceptance criteria checked via automated tests
(`packages/cli/test/commands/fold-tree.test.ts`):

| Criterion | Test |
| --- | --- |
| New `packages/cli/src/commands/fold.ts` | file exists; wired in `src/index.ts` |
| Parent gets the commits | `folds a leaf branch into its non-trunk parent (keep-commits)` asserts `feat/base` log contains `child-commit` |
| Children re-parent correctly | `re-parents children of folded branch onto the grandparent` asserts each child's `parent` field + `parent_revision` after fold |
| PR closed with comment if present | `closes the PR with a comment when the folded branch had an OPEN PR` asserts `closePrWithComment(42, "Folded into \`feat/base\`...", ...)` was invoked |
| `--force` flag works | every happy-path test passes `{ force: true }`; `rejects fold without --force in non-interactive mode` asserts the negative |
| `--squash` flag works | `--squash mode collapses commits into one on the parent` asserts post-fold commit count is exactly old+1 and the squash subject is the first folded subject; `--squash mode rebases descendants onto the new squash commit` asserts a leaf's `^` is the squash commit |
| Restack runs automatically | `re-parents children of folded branch onto the grandparent` asserts `restacked: true`; the squash+descendants test additionally proves the rebase actually moved the leaf onto the squash commit |
| Tests for each path | 13 tests in `fold-tree.test.ts` covering happy paths, edge cases, and guards |
| Docs at `apps/docs/content/docs/commands/fold.mdx` | new file present and indexed in `meta.json` |

Adversarial review (2 rounds) caught 5 defects in the first cut and verified
all 4 in-scope fixes in the second pass:

1. Blind PR closure on already-merged/closed PRs → now guarded with
   `getPrStateByNumber` + `'OPEN'` check; covered by
   `does not close PR when it is already merged or closed`.
2. No worktree guard on the folded branch → now calls
   `listWorktreeCheckouts`; covered by
   `rejects fold when the target branch is checked out in another worktree`.
3. Children `parent_revision` set to wrong tip (would silently orphan
   descendants of a squashed branch) → now set to the OLD branch tip so
   `restack` does the right `git rebase --onto newParent oldBase child`;
   covered by `--squash mode rebases descendants onto the new squash commit`.
4. Null `parent_revision` skipped the staleness guard → now falls back to
   `getMergeBase`.

Deferred (out of scope for this issue, matches existing `delete.ts` pattern):
adding a `'fold'` operation type to the undo log.

## Gates

Run from repo root on this branch:

- `pnpm checks` — passed (biome, 274 files, 0 fixes applied)
- `pnpm typecheck` — passed (turbo: 2/2 packages, tsc --noEmit)
- `pnpm test` — passed (90 files, 840 tests, +13 new fold tests)

`pnpm evals` was skipped: no AI metadata or prompts changed (evals fail
preexisting in this workspace because no AI provider key is configured).

## Evidence

- `.reports/dub-33-report-data.json` — file tour, stats, and review summary
- `.reports/dub-33.html` — rendered report
- Tests: `packages/cli/test/commands/fold-tree.test.ts`
