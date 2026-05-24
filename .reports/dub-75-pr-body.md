## TL;DR

Adds 6 tree-shape restack scenarios as integration tests and fixes a state-persistence bug where parent_revision updates for already-rebased siblings were lost when a later sibling conflicted.

## Why

Tier 1 — Branching Stack Support depends on dub restack working safely on trees; DUB-20 made submit walk trees, this closes the matching gap on restack.

Acceptance criteria require asserting final parent_revision values, not just rebase success — without those tests, a state-persistence bug went undetected.

Copilot follow-up surfaced a crash-safety concern: writeProgress before writeState left a window where a writeState failure would strand a step marked done in progress with stale parent_revision on disk.

### Before

- restack.test.ts covered only linear stacks; no multi-sibling case existed despite topologicalOrder/snapshot-before-rebase being tree-shaped on paper.
- executeRestackSteps only called writeState at the very end of the loop; when a later sibling conflicted, in-memory parent_revision updates for already-rebased siblings were discarded.
- On dub restack --continue, those branches stayed marked 'done' in progress and were never re-applied, leaving stale parent_revision values long after the rebase actually moved them.
- writeProgress was ordered before writeState, so a writeState failure could leave progress ahead of state and the same stale-state bug would reappear after a partial disk error.

### After

- packages/cli/test/commands/restack-tree.test.ts pins all 6 DUB-75 scenarios: trunk→base→3-sibling cascade, sub-tree restack from a non-root sibling, sibling conflict + dub continue, sibling already squash-merged, sibling held in a worktree, restack from the trunk root.
- Each scenario asserts the final parent_revision for every affected branch matches the expected new tip — strictly, not 'rebase ran'.
- executeRestackSteps persists state immediately after each successful rebase and after each 'parent didn't move' skip, so a later conflict cannot discard completed cascades.
- writeState now runs BEFORE writeProgress so a writeState failure leaves the step pending (retryable on next run) instead of stranding it as done with stale parent_revision.

## File-by-file

### packages/cli/test/commands/restack-tree.test.ts

new +298 / -0

Six integration scenarios for tree-shaped restack. Uses create() + git checkout between siblings to build real trees with parent_revision tracking, then asserts both the rebased return list AND the final parent_revision per branch via findStackForBranch. Scenario 3 also exercises the dub continue path after a sibling conflict.

```ts
it('scenario 3: one sibling conflicts; other siblings preserved; continue resumes remaining', async () => {
  // main → {feat/a, feat/b, feat/c}; b will conflict with main on conflict.txt
  ...
  expect(first.status).toBe('conflict');
  expect(first.conflictBranch).toBe('feat/b');
  expect(first.rebased).toEqual(['feat/a']);
  ...
  const second = await restackContinue(dir);
  expect(second.rebased).toEqual(['feat/a', 'feat/b', 'feat/c']);
  expect(getBranch(state, 'feat/a')?.parent_revision).toBe(newMainTip);
  expect(getBranch(state, 'feat/b')?.parent_revision).toBe(newMainTip);
  expect(getBranch(state, 'feat/c')?.parent_revision).toBe(newMainTip);
});
```

### packages/cli/src/commands/restack.ts

mod +12 / -2

executeRestackSteps now persists state in-loop. Two ordering rules: (1) call writeState BEFORE writeProgress so a writeState failure leaves the step pending instead of stranded; (2) persist after every successful rebase and every no-op skip so a later sibling conflict cannot discard already-cascaded parent_revision updates. The patch-equivalent skip path is intentionally left unchanged — it must NOT update parent_revision (squash-merge preservation, covered by existing tests).

```ts
try {
  await rebaseOnto(parentNewTip, step.parentOldTip, step.branch, cwd);
  updateParentRevision(state, step.branch, parentNewTip);
  // Persist state BEFORE marking the step done in progress: if
  // writeState fails, the step stays pending and the next run retries
  // the rebase; if we wrote progress first, a writeState failure would
  // leave parent_revision stale on disk and continue would skip the
  // already-done step (the original DUB-75 bug, in a different shape).
  await writeState(state, cwd);
  step.status = 'done';
  rebased.push(step.branch);
  await writeProgress(progress, cwd);
} catch (error) { ... }
```

## Where to focus review

1. **Crash-safety of the writeState/writeProgress ordering** - `packages/cli/src/commands/restack.ts:202-241`: If writeProgress fires before writeState, a writeState failure (disk full, permission flap) marks the step done in progress.json while parent_revision stays stale in state.json — restack --continue then skips the already-done step and never recovers. The swap makes the failure mode retryable. Verify the swap holds in both the rebase-success path and the 'parent didn't move' skip path.
2. **Scenario 3 conflict + continue assertions are exhaustive** - `packages/cli/test/commands/restack-tree.test.ts:135-178`: This is the scenario that surfaces the original bug. It asserts parent_revision for feat/a (rebased before conflict), feat/b (resumed via continue), AND feat/c (rebased fresh after continue) all equal the new main tip. Without all three assertions the regression could slip through.
3. **Sibling order determinism for BFS+alpha sort** - `packages/cli/test/commands/restack-tree.test.ts:71-73, 124-126`: Tests pin exact .toEqual() ordering for the rebased list. This is intentional — topologicalOrder sorts siblings via localeCompare. Reviewers should confirm branch names in the tests (feat/a, feat/b, feat/c, feat/a1) were chosen to make the assertion stable under alpha sort.
4. **Worktree-skip log capture in scenario 5** - `packages/cli/test/commands/restack-tree.test.ts:213-262`: Uses vi.spyOn(console, 'log') to assert formatWorktreeCheckoutSkipMessage emits exactly once for feat/b. Cleanup is wrapped in try/finally so the spy and the worktree are released even if assertions throw.

## Test plan

- [x] **integration:** 6 new tree-shape restack scenarios - packages/cli/test/commands/restack-tree.test.ts — all 6 scenarios pass; scenario 3 specifically failed before the writeState fix and now passes, demonstrating the bug is caught.
- [x] **unit:** Existing restack.test.ts (19 cases) still passes - pnpm test — 695/695 across the whole repo; restack.test.ts:1-498 all green, including the squash-merge-then-restack suite that depends on the patch-equivalent skip path NOT updating parent_revision.
- [x] **build:** Repo-wide lint + typecheck - pnpm checks (biome lint+format) clean across 247 files; pnpm typecheck clean for dubstack + docs.

## Quality gates

- **lint + format:** `pnpm checks` - passed (biome check . — Checked 247 files, no fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (turbo run typecheck — 2 tasks successful (dubstack + docs).)
- **unit + integration tests:** `pnpm test` - passed (vitest — 85 test files, 695 tests passing.)
- **CI (PR #54):** `GitHub Actions on push` - passed (All 9 checks SUCCESS (check, autofix, lint, merge-order, CodeQL ×3, Vercel, Vercel Preview Comments); Vercel Agent Review NEUTRAL (informational). Merge state CLEAN.)

## Self-QA

See [QA fallback evidence](.reports/dub-75-qa.md).

Self-QA fallback documents test scenarios, bug reproduction, fix verification, and review iterations.

- Scenario 1: trunk → base → 3-sibling cascade — every node's parent_revision matches new tip, no commit duplication
- Scenario 2: restack from non-root sibling — whole tree restacked in BFS+alpha order, parent_revision correct on all 4 branches
- Scenario 3: sibling conflict + dub continue — pre-conflict sibling preserved, conflicted sibling resumed, remaining sibling completed, all parent_revisions correct
- Scenario 4: sibling already squash-merged — skipped via hasUniquePatchCommits, other sibling restacks; final tree has both files, no duplicates
- Scenario 5: sibling held in a worktree — skipped with exactly one log line, git tip untouched, other siblings rebase
- Scenario 6: restack from trunk root — all descendants rebased in topo order, parent_revisions correct

## Acceptance criteria

- [x] New packages/cli/test/commands/restack-tree.test.ts covering all 6 scenarios - 298-line test file checked in; describe block runs 6 scenarios named 1–6 mapping directly to the issue's scenario list.
- [x] No regression in existing restack.test.ts - All 19 restack.test.ts cases pass alongside the 6 new tree cases; full repo 695/695.
- [x] If any scenario surfaces a bug, fix in restack.ts and reflect in PR description - Scenario 3 surfaced the writeState-only-at-end-of-loop bug. Fixed in restack.ts with two in-loop writeState calls (success path + no-op skip path), then hardened against partial-write failure by ordering writeState before writeProgress. PR body documents both.
- [x] Each scenario asserts final parent_revision matches the expected new tip, not just that 'the rebase ran' - Every scenario reads state via readState() and asserts getBranch(state, name)?.parent_revision against the expected SHA. Scenario 1 also asserts no commit duplication via git log inspection.

## Adversarial review

Iterations: 3

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Pass 1 (pre-commit): symmetrical writeState on the same-tip skip path was missing; scenario 3 assertion was under-specified with .toContain. Resolved before initial commit (29307b6).
- Pass 2 (self-review, commit 02b273b): replaced inline getBranch loop with findStackForBranch from state.ts; clarified BFS-with-alpha-sort comment in scenario 2; fixed misleading 'replayed' wording in scenario 3 continue comment; added matching why-comment on the skip-path writeState.
- Pass 3 (Copilot review, commit 8f87afe): ordering between writeProgress and writeState created a partial-write window where a writeState failure could leave the step done in progress with stale parent_revision. Swapped to writeState-first in both the success and no-op skip paths. Both Copilot threads replied and resolved.

## Dependencies

- **DUB-20 — Tree-walking submit (remove branching-blocker rejection):** Done. Verified state via linear issues get DUB-20 before starting. No code dependency from this PR; DUB-20 unlocked the Tier 1 tree work that DUB-75 audits.

## Rollout

Standard merge to main. No data migration, no flag, no env var, no CLI surface change. The writeState ordering change is internal to executeRestackSteps and is covered by both the new and the existing restack tests.

- **merge - Land PR #54:** Squash-merge once CI is green. Ships in the next dub release alongside DUB-20's tree-walking submit.
- **post-merge - No follow-up required:** Scenario 3 is now permanent regression coverage for the state-persistence ordering. No flag flip, no deprecation timeline, no operator action.

## Commit

```text
fix(restack): write state before progress so retries can recover [DUB-75]
```
