## TL;DR

merge-next now walks the stack BFS from trunk, calls getPrMergeStatusByNumber on candidates, prefers the current branch's path on ties, prints other mergeable siblings as a hint, and surfaces a clean DubError when the lowest non-empty depth has only blocked PRs.

## Why

Tier 1 — Branching Stack Support: with DUB-20 unblocking tree-shaped submits, merge-next was the next link in the chain that still assumed a linear path.

The previous implementation never called getPrMergeStatusByNumber, so a BLOCKED PR would reach mergePr and fail with a noisy GitHub error instead of a clean DubError.

For trees, picking by 'first branch in the current downstack path' is ambiguous and easily picks the wrong sibling.

### Before

- merge-next.ts:32 called getSubmitPlan(cwd, { path: 'current', fix: true }) and took plan.branches[0] — the bottom of the current path.
- getPrMergeStatusByNumber existed in lib/github.ts but was never consulted by merge-next.
- A BLOCKED PR would propagate to mergePr and surface as a raw gh CLI error after at least one retargetPrBase mutation.

### After

- merge-next walks getSubmitPlan(cwd, { path: 'stack' }) in BFS depth order and consults getAllPrSyncInfoBatch + getPrMergeStatusByNumber to evaluate each candidate.
- Ties at the same depth prefer the current branch's ancestor path; the remaining MERGEABLE peers are returned as siblingCandidates and printed as an ℹ hint by the CLI.
- A lowest depth with only blocked candidates throws DubError listing each PR number, mergeable, and mergeStateStatus — no retargetPrBase or mergePr call is attempted.
- Result type gains siblingCandidates: string[] (always present, possibly empty) so the CLI and downstream tooling can render the hint deterministically.

## File-by-file

### packages/cli/src/commands/merge-next.ts

mod +233 / -18

Rewrites mergeNext to call getSubmitPlan with path:'stack', batch-load PR lifecycle via getAllPrSyncInfoBatch (with getBranchPrSyncInfo fallback when truncated), compute depths via a local BFS, group plan branches by depth, evaluate each for parent eligibility + OPEN lifecycle + MERGEABLE status, tie-break on the current-branch ancestor path, and return siblingCandidates. A blocked lowest depth throws DubError immediately and never descends.

```ts
if (mergeable.length === 0) {
  // Lowest depth with candidates has none mergeable — surface the blocked
  // status. Never descend past a blocked floor: even if a deeper child's
  // parent eligibility somehow passed, merging it ahead of its blocked
  // ancestor would corrupt stack ordering.
  blockedAtFirstDepth.push(...evaluated);
  break;
}
```

### packages/cli/src/commands/merge-next.test.ts

mod +370 / -69

Replaces the linear-only mocks with a shared makePlan + lifecycleBatch helper, adds mocks for getAllPrSyncInfoBatch / getBranchPrSyncInfo / getPrMergeStatusByNumber, and pins the new contract with six tree-selection cases (3-sibling current-path preference, 3-sibling off-path alphabetical pick, depth-1 wins over mergeable grandchild, mixed mergeable+blocked hint exclusion, blocked-only floor errors and skips mutation, blocked-floor with mergeable grandchild still errors, dry-run reflects target + hint).

```ts
it('does not descend past a blocked floor: depth-1 BLOCKED with mergeable descendant still errors', async () => {
  // ...
  await expect(mergeNext('/repo')).rejects.toThrow(
    /No mergeable PR at this stack level.*feat\/blocked/,
  );
  expect(mockMergePr).not.toHaveBeenCalled();
  expect(mockRetargetPrBase).not.toHaveBeenCalled();
});
```

### packages/cli/src/index.ts

mod +15 / -0

Adds a printSiblingHint helper in the merge-next action that emits an ℹ line listing siblingCandidates plus a one-line 'dub co <branch> then rerun' nudge. Fired for both dry-run and real runs after the existing pre-merge-retarget line.

```ts
const printSiblingHint = () => {
  if (result.siblingCandidates.length === 0) return;
  console.log(
    chalk.dim(
      `ℹ Other candidates at this stack level: ${result.siblingCandidates.join(', ')}`,
    ),
  );
  console.log(
    chalk.dim(
      "   Switch with 'dub co <branch>' and rerun 'dub merge-next'.",
    ),
  );
};
```

## Where to focus review

1. **BFS termination on a blocked floor** - `packages/cli/src/commands/merge-next.ts:237-247`: When the lowest non-empty depth has no MERGEABLE candidate, the loop breaks and returns blockedAtFirstDepth so the caller throws — never descending to a deeper branch. A regression test pins this even in the corner case where a grandchild happens to be MERGEABLE.
2. **Parent eligibility and the truncated-batch fallback** - `packages/cli/src/commands/merge-next.ts:210-225, 262-274`: A non-trunk parent must report MERGED lifecycle to make its child eligible. Lifecycle reads come from getAllPrSyncInfoBatch (populated with --state all) and fall back to per-branch getBranchPrSyncInfo when the batch is truncated, matching the existing sync helpers.
3. **Tie-break and sibling-hint exclusion of blocked peers** - `packages/cli/src/commands/merge-next.ts:245-253`: siblings is computed from the already-MERGEABLE-only list, so blocked peers can never leak into the hint. The current-branch ancestor path drives the tie-break; off-path picks fall back to ascending branch-name order from the BFS pass.

## Test plan

- [x] **unit:** merge-next vitest suite (11 cases) - pnpm test -- merge-next → Test Files 1 passed (1), Tests 11 passed (11), Duration 119ms.
- [x] **unit:** full dubstack vitest suite - pnpm test → 84 files passed, 694 tests passed, Duration 6.61s.
- [x] **build:** tsc --noEmit (docs + dubstack) - pnpm typecheck → 2 successful, 2 total.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (Checked 246 files in 50ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (turbo run typecheck → 2 successful, 2 total.)
- **Vitest:** `pnpm test` - passed (84 test files, 694 tests, all green.)
- **Evals:** `pnpm evals` - skipped (AI metadata / prompts untouched; per CLAUDE.md evals only run when those change. The local environment also lacks AI credentials.)

## Self-QA

See [QA fallback evidence](.reports/dub-22-qa.md).

Deterministic proof via gates + 11-case vitest suite covering each acceptance criterion.

- 3-sibling tree under trunk, current branch wins, other mergeable peers reported as siblingCandidates.
- 3-sibling tree from an off-stack branch picks the alphabetically first mergeable child of trunk.
- Linear parent → grandchild stack picks depth 1 without probing the grandchild's mergeability.
- Mixed MERGEABLE + BLOCKED siblings: hint excludes the BLOCKED branch.
- BLOCKED-only depth-1 candidate throws DubError with PR#, mergeable, mergeStateStatus inlined; mergePr / retargetPrBase never called.
- BLOCKED depth-1 with a MERGEABLE grandchild still errors (no silent descent).
- Dry-run reports chosen target + sibling hint without mutating GitHub.
- Existing linear-stack pre-merge child retarget + postMerge orchestration unchanged.

## Acceptance criteria

- [x] BFS-based target selection in commands/merge-next.ts - computeDepths + selectMergeTarget walk BFS from the root and group plan.branches by depth before choosing (merge-next.ts:133-199).
- [x] getPrMergeStatusByNumber actually invoked; non-MERGEABLE statuses produce a clean DubError with recovery hints - Each eligible candidate is fed to getPrMergeStatusByNumber (merge-next.ts:230); blockedCandidateError emits a DubError with mergeable + mergeStateStatus + 3 recovery steps (merge-next.ts:280-300).
- [x] Tie-breaking by current-path membership - currentPathBranchNames walks parent links from the current branch; selectMergeTarget prefers onCurrentPath candidates before falling back to the BFS-ordered first mergeable (merge-next.ts:165-179, 245-249).
- [x] Hint printed when ties exist - Result includes siblingCandidates; index.ts:837-877 prints 'ℹ Other candidates at this stack level: ...' plus a 'dub co <branch>' nudge in both dry-run and real-merge paths.
- [x] Tests: 3-sibling tree, base merges first; sibling tie, current path wins with hint - merge-next.test.ts: '3-sibling tree from a non-stack branch: picks the alphabetically first mergeable child of trunk' and '3-sibling tree: prefers branch on the current path and reports the others'.
- [x] Tests: candidate is BLOCKED → clean error, no GitHub mutation attempted - merge-next.test.ts: 'errors cleanly and does not merge when the only depth-1 candidate is BLOCKED' asserts the regex on the DubError message AND that mockMergePr / mockRetargetPrBase were never called.
- [x] Tests: dry-run output reflects the chosen target - merge-next.test.ts: 'dry-run reflects the chosen target and sibling hint' asserts mergedBranch, prNumber, and siblingCandidates while confirming no mutation.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Critical (resolved): the loop previously used `continue` when the lowest non-empty depth had no MERGEABLE candidates, so a deeper depth whose parent eligibility happened to pass could be chosen ahead of a blocked floor. Replaced `continue` with `break`, populated blockedAtFirstDepth unconditionally on that path, and added the 'does not descend past a blocked floor' regression test.
- Important (resolved): the sibling-hint list was not test-pinned against leakage of BLOCKED peers. Added 'sibling hint lists only MERGEABLE peers — blocked siblings are excluded' which mixes one BLOCKED sibling with two MERGEABLE ones and asserts siblingCandidates excludes it.
- Important (considered, not changed): reviewer flagged that lifecycleForBranch returns 'NONE' for branches absent from a non-truncated batch. In practice getAllPrSyncInfoBatch queries `gh pr list --state all` (covering OPEN / CLOSED / MERGED) and only flags truncated when ≥ 100 PRs are returned, so an absent branch genuinely has no PR. The existing truncation fallback to getBranchPrSyncInfo covers the over-100 case. No code change needed.

## Dependencies

- **DUB-20 (Tree-walking submit, remove branching-blocker rejection):** satisfied — merged on main (commit 86303e2). Stacks with trees now exist for merge-next to operate on.

## Rollout

Pure CLI logic change. No migrations, no feature flag, no AI prompt churn. Behaviour on linear stacks is unchanged (existing pre-merge child retarget + postMerge orchestration still fires).

- **On merge - Ship as-is:** No further action needed; the new behaviour activates the moment users pick up the next dub release.
- **Post-merge - Update DUB-22 to Done:** Linear was rate-limited during execution; move DUB-22 to Done once the PR lands and confirm DUB-19/DUB-12-style siblings are unblocked.

## Commit

```text
feat(merge-next): tree-aware target with mergeability check
```
