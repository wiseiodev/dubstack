## TL;DR

Adds `dub fold` (`packages/cli/src/commands/fold.ts` + `packages/cli/src/lib/fold.ts`). Keep-commits mode fast-forwards the parent; `--squash` collapses the branch into one commit. Children re-parent onto the former parent and `restack` rebases them — critically, fold records the OLD branch tip as their `parent_revision` so restack's `git rebase --onto newParent oldBase child` actually moves descendants in squash mode. Guards: dirty tree, root branches, fold-into-trunk, no commits, parent drift (via `parent_revision` or `getMergeBase`), worktree checkout conflicts. PR closure is gated on `getPrStateByNumber === 'OPEN'` so stale `pr_number`s on merged/closed PRs are no-ops.

## Why

Tier 3 power-command gap: dubstack had no way to collapse a sub-branch back into its parent when a feature ended up small enough to ship as one branch.

Equivalent to `gt fold`; users coming from Graphite expect this primitive when reorganizing stacks.

Without `dub fold`, the manual workaround (`git checkout parent && git merge --ff-only child`, then untrack, delete, retarget PRs, restack) is fiddly and easy to get wrong on tree-shaped stacks.

### Before

- No `fold` command. Users had to drop down to raw git + `dub untrack`/`dub delete` and manually retarget any open PRs.
- Re-parenting children onto a grandparent had no idiomatic flow; it relied on `dub track --parent <new>` per child followed by `dub restack`.

### After

- `dub fold` (with optional `--squash`, `--force`, and `--keep-commits` flags) handles the full flow in one command.
- Children of the folded branch automatically re-parent onto the grandparent and are restacked.
- Open PRs for the folded branch are closed with a comment naming the new parent; already-merged/closed PRs are left untouched.
- Strict preconditions prevent unsafe folds: dirty tree, root branches, fold-into-trunk, no-op (no commits), parent drift, and same-branch-checked-out-in-another-worktree all fail with `DubError` recovery hints.

## File-by-file

### packages/cli/src/lib/fold.ts

new +301 / -0

Core library: validation (tracked, non-root, parent-not-trunk, clean tree, no worktree collision, parent up-to-date via parent_revision or merge-base, has commits to fold), keep-commits/squash git ops, state mutation. Critically, sets each child's `parent_revision = branchTip` (the OLD deleted-branch tip) so the subsequent `restack` does the right `git rebase --onto newParent oldBase child` — setting it to `newParentTip` would silently no-op restack and orphan squash-mode descendants on the dead ref.

```ts
// Re-parent children of the folded branch onto its former parent.
// Record the OLD branch tip as their parent_revision (not the new
// parent tip): restack uses parent_revision as the 'old base' for
// `git rebase --onto <newParent> <oldBase> <child>`. In keep-commits
// mode old==new and restack is a no-op; in squash mode restack
// rewrites children from the dead branch tip onto the new squash
// commit. Setting parent_revision to newParentTip would make restack
// a silent no-op and leave squashed descendants orphaned.
for (const child of stack.branches) {
  if (child.parent === branchName) {
    child.parent = parentName;
    child.parent_revision = branchTip;
  }
}
```

### packages/cli/src/commands/fold.ts

new +150 / -0

CLI wrapper: prompt + confirmation, runs `foldBranch`, then closes any OPEN PR (gated on `getPrStateByNumber`), then runs `restack` if there were children. A non-OPEN PR (merged or closed) is left alone — pr_number persists in state after submit and is never cleared, so blind closure would error on every fold of a merged branch.

```ts
if (result.prNumber != null) {
  try {
    await ensureGhInstalled();
    await checkGhAuth();
    // Only close PRs that are actually open. The pr_number in state
    // is set at submit time and never cleared, so it may point at an
    // already-merged or already-closed PR.
    const prState = await getPrStateByNumber(result.prNumber, cwd);
    if (prState === 'OPEN') {
      await closePrWithComment(
        result.prNumber,
        `Folded into \`${result.parent}\` via \`dub fold\`.`,
        cwd,
      );
      prClosed = true;
    }
  } catch (error) { ... }
}
```

### packages/cli/src/index.ts

mod +73 / -0

Wires up `dub fold` with `--force`, `--squash`, `--keep-commits`, and `--no-interactive` flags. Rejects `--squash` + `--keep-commits` combo. Outputs commit-count summary, re-parented children count, restack status, and closed-PR number.

```ts
program
  .command('fold')
  .description('Combine the current branch into its parent, re-parenting children')
  .option('-f, --force', 'Skip the deletion confirmation prompt')
  .option('--squash', 'Collapse the branch into one commit on the parent (default keeps commits)')
  .option('--keep-commits', 'Preserve commits as separate commits on the parent (default)')
  .option('--no-interactive', 'Disable prompts and require --force')
```

### packages/cli/src/lib/git.ts

mod +71 / -0

Adds two helpers used by fold: `getCommitSubjectsBetween(base, head)` (for building squash commit messages, oldest-first) and `mergeSquashAndCommit(branch, message)` (runs `git merge --squash <branch>` then commits with the given message).

```ts
export async function mergeSquashAndCommit(
  branch: string, message: string, cwd: string,
): Promise<void> {
  await execa('git', ['merge', '--squash', branch], { cwd });
  await execa('git', ['commit', '-m', message], { cwd });
}
```

### packages/cli/src/lib/github.ts

mod +26 / -0

Adds `closePrWithComment(prNumber, comment, cwd)` — single `gh pr close --comment` call routed through the existing `runGh` retry wrapper, with `DubError` recovery hints on failure.

```ts
export async function closePrWithComment(
  prNumber: number, comment: string, cwd: string,
): Promise<void> {
  try {
    await runGh(['pr', 'close', String(prNumber), '--comment', comment], { cwd });
  } catch (error) { ... }
}
```

### packages/cli/test/commands/fold-tree.test.ts

new +360 / -0

13 integration tests running against real temporary git repos: leaf fold (keep-commits), children re-parent to grandparent, squash collapses into one commit, squash + descendants properly rebased (the critical squash-mode bug from adversarial review), PR closure for OPEN PRs, no PR closure for merged/closed, and 7 guard tests (trunk parent, drift, no-confirm-no-force, no commits, root branch, worktree conflict, dirty tree).

```ts
it('--squash mode rebases descendants onto the new squash commit', async () => {
  // main -> feat/base -> feat/mid -> feat/leaf, then fold feat/mid --squash
  // ...
  const newBaseTip = await getBranchTip('feat/base', dir);
  const leafParentSha = (await gitInRepo(dir, ['rev-parse', 'feat/leaf^'])).stdout.trim();
  // feat/leaf's immediate parent commit must be the new squash commit on
  // feat/base - otherwise leaf is orphaned on the dead branch tip.
  expect(leafParentSha).toBe(newBaseTip);
});
```

### apps/docs/content/docs/commands/fold.mdx

new +46 / -0

Docs page for `dub fold`: usage, behavior, flags, examples.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Adds `fold` to the docs command index between `post-merge` and `undo`.

### .reports/dub-33-qa.md

new +65 / -0

Self-QA fallback: explains why no video (CLI, no UI surface), maps each acceptance criterion to its test, and summarizes the adversarial-review fixes.

## Where to focus review

1. **Squash-mode descendant rebase** - `packages/cli/src/lib/fold.ts:262-275`: Children's parent_revision must be set to the OLD branch tip (`branchTip`), not the new parent tip. The first adversarial review caught this — setting it to newParentTip silently makes the subsequent restack a no-op in squash mode, orphaning descendants on the deleted ref. Test: `--squash mode rebases descendants onto the new squash commit`.
2. **Parent staleness guard** - `packages/cli/src/lib/fold.ts:222-238`: Falls back to `getMergeBase` when `parent_revision` is null (older state, manually-tracked branches), so an old branch that has drifted from its parent cannot silently absorb unrelated history during fold.
3. **PR closure gate** - `packages/cli/src/commands/fold.ts:107-126`: `pr_number` in state is set at submit time and never cleared. Without the `getPrStateByNumber === 'OPEN'` guard, fold would call `gh pr close` on already-merged/closed PRs (error noise + semantically wrong).
4. **Worktree collision guard** - `packages/cli/src/lib/fold.ts:192-208`: Without this guard, `deleteLocalBranch` later in the flow would fail after parent had already advanced, leaving git and dubstack state diverged.

## Test plan

- [x] **integration:** fold-tree.test.ts (13 tests, real git temp repos) - All happy paths + 7 guard cases pass; total suite 840 passing (+13 new).
- [x] **build:** biome + tsc + vitest gates - pnpm checks / typecheck / test all green on commit b2cd722.
- [x] **manual:** Adversarial review - Two rounds; first round flagged 5 issues, 4 fixed in scope, 1 deferred (undo for fold, matches delete.ts convention).

## Quality gates

- **Lint/format (biome):** `pnpm checks` - passed (Checked 274 files in 42ms. No fixes applied.)
- **Type check (tsc, turbo):** `pnpm typecheck` - passed (Tasks: 2 successful, 2 total (dubstack + docs).)
- **Tests (vitest, turbo):** `pnpm test` - passed (Test Files 90 passed (90); Tests 840 passed (840).)
- **AI evals:** `pnpm evals` - skipped (No AI metadata or prompts changed; evals fail preexisting in this workspace (no AI provider keys configured).)

## Self-QA

See [QA fallback evidence](.reports/dub-33-qa.md).

Deterministic test proof in lieu of a video for the new dub fold CLI command.

- Leaf fold (keep-commits) advances parent and removes branch
- Children of folded branch are re-parented and restacked
- --squash collapses commits and descendants rebase onto the new squash commit
- PR is closed with comment when OPEN; left alone when MERGED/CLOSED
- Guards: dirty tree, root branch, fold-into-trunk, no commits, drift, worktree collision, non-interactive without --force

## Acceptance criteria

- [x] New packages/cli/src/commands/fold.ts - File exists at packages/cli/src/commands/fold.ts and wired in src/index.ts.
- [x] Parent gets the commits - `folds a leaf branch into its non-trunk parent (keep-commits)` asserts feat/base log contains the folded commit.
- [x] Children re-parent correctly - `re-parents children of folded branch onto the grandparent` + `--squash mode rebases descendants` assert state.parent + git history.
- [x] PR closed with comment if present - `closes the PR with a comment when the folded branch had an OPEN PR` asserts closePrWithComment invocation with the canonical message.
- [x] --force and --squash flags work - Every happy-path test uses --force; squash-specific tests cover --squash semantics; index.ts rejects --squash + --keep-commits combo.
- [x] Restack runs automatically - fold command invokes restack when childrenReparented.length > 0; squash + descendants test proves the rebase actually happened.
- [x] Tests for each path - 13 tests in fold-tree.test.ts covering 4 listed scenarios + 9 guards/edge cases.
- [x] Docs at apps/docs/content/docs/commands/fold.mdx - fold.mdx exists with usage/behavior/flags/examples; meta.json indexes it.

## Adversarial review

Iterations: 2

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Round 1 (4 critical, 1 important): (1) blind PR closure on merged/closed PRs, (2) no worktree guard on folded branch, (3) state mutation has no undo entry (deferred — matches delete.ts), (4) children.parent_revision set to wrong tip silently orphans squash-mode descendants, (5) null parent_revision skipped the staleness guard.
- Round 1 fixes (4 of 5 in scope): PR closure now gated on getPrStateByNumber === 'OPEN'; worktree check added with explicit DubError; children.parent_revision set to branchTip (OLD tip) so restack rebases correctly; parent_revision null falls back to getMergeBase.
- Round 2 verdict: all 4 in-scope fixes verified correct. Minor: keep-commits children-reparent test asserts parent_revision == newBaseTip, which is vacuously true (newBaseTip == branchTip in ff-only mode); the squash test adequately covers the critical-bug regression.
- Deferred: extending the undo log to a 'fold' operation type. Out of scope for DUB-33 acceptance criteria, and the existing delete.ts uses the same write-after-mutate pattern.

## Dependencies

- **DUB-33 listed dependencies:** No external dependencies detected (issue says: 'Blocked by: None — can start immediately').

## Rollout

Pure additive CLI command. Safe to merge whenever review approves; no migrations, no config changes, no flag gating.

- **Pre-merge - Review + merge PR:** Standard PR review on the new command, library, and tests. Default branch CI will run the same gates this report ran locally.
- **Post-merge - Docs publish:** fold.mdx is added to apps/docs/content/docs/commands and indexed in meta.json — published with the next docs build.
- **Post-merge - Future work:** Optional: extend the undo log with a 'fold' operation type to enable `dub undo` recovery from a partial fold failure (current convention in delete.ts is also write-after-mutate without undo).

## Commit

```text
feat(fold): combine a branch into its parent

`dub fold` collapses the current branch into its parent: fast-forwards
(or squashes) parent to branch tip, re-parents children onto former
parent, runs restack, deletes branch, and closes any OPEN PR with a
"Folded into <parent>" comment.

Guards: dirty tree, root branches, fold-into-trunk, no commits,
parent drift (uses parent_revision or merge-base), worktree checkout
conflicts. Children's parent_revision is set to the OLD branch tip so
restack rewrites squash-mode descendants onto the new squash commit
instead of orphaning them on the deleted ref.

Completes DUB-33
```
