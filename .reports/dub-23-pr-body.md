## TL;DR

Test-only addition: 7 mock-based vitest scenarios in `post-merge-tree.test.ts` that pin tree-shape behavior for `dub post-merge` (cleanup, reparenting, PR retargeting, surviving-descendant checkout, post-cleanup stack-wide submit). No production code changes.

## Why

DUB-23 verification on 2026-05-23 confirmed `post-merge.ts` already handles trees: `getMergedBottomBranches` accepts any MERGED PR whose parent is root-or-already-merged (tree-shape agnostic), `removeBranchFromStack` reparents every child of the deleted branch in one pass, and `retargetOpenPrBranches` runs over the full working stack rather than a path.

Without coverage, a future refactor (DUB-77 cleanup-journal unification, or any change to topological iteration order) could silently break tree behavior — the existing `post-merge.test.ts` only exercises linear chains.

DUB-21 shipped the tree-shaped PR body table; nothing pinned that post-merge actually triggers a PR body refresh on the surviving tree.

### Before

- `post-merge.test.ts` covered only linear stacks (`main → feat/a → feat/b`).
- No assertion that multiple children of a merged middle branch all get reparented in one pass.
- No assertion that a base + descendant cascade leaves both surviving descendants on the root.
- No assertion that the post-cleanup `submit(..., { stack: true })` fires — which is the mechanism that rewrites every PR body's stack table via `updateAllPrBodies`.

### After

- Seven new tests in `post-merge-tree.test.ts` cover every tree shape DUB-23 enumerates plus PR body refresh plumbing and surviving-descendant checkout.
- Linear `post-merge.test.ts` untouched and still green (768/768 total).
- Any future regression in cleanup ordering, reparent fan-out, or stack-wide submit invocation will fail one of these tests.

## File-by-file

### packages/cli/test/commands/post-merge-tree.test.ts

new +412 / -0

Mock-based vitest spec modeled after `packages/cli/src/commands/post-merge.test.ts`. Mocks `lib/git.js`, `lib/github.js`, `lib/cleanup-journal.js`, `lib/state.js` (preserves real types/topo helpers), and the `restack` + `submit` command modules. Helper `mockPrState(state, merged)` snapshots each branch's parent at setup time so `getBranchPrSyncInfo` returns the ORIGINAL `baseRefName` — mirroring what GitHub would return before `gh pr edit --base` fires. This is what makes retarget assertions meaningful: after state mutation moves a child onto a new parent, `prInfo.baseRefName !== branch.parent` is true and `retargetPrBase` is invoked.

```ts
function mockPrState(state: DubState, mergedBranches: Set<string>) {
  const originalParent = new Map(
    state.stacks.flatMap((s) =>
      s.branches.map((b) => [b.name, b.parent] as const),
    ),
  );
  // ... snapshotted base mirrors gh BEFORE post-merge edits the PR.
  mockGetBranchPrSyncInfo.mockImplementation(async (branch) => {
    const base = originalParent.get(branch) ?? null;
    return { state: mergedBranches.has(branch) ? 'MERGED' : 'OPEN', baseRefName: base };
  });
}
```

### .reports/dub-23-qa.md

new +60 / -0

QA fallback per `do-issue` skill: no production code changed and no `.tsx` files were touched, so no browser video is required. Records the seven scenarios and the gates that passed (biome, tsc, vitest 768/768).

## Where to focus review

1. **`mockPrState` snapshot semantics** - `packages/cli/test/commands/post-merge-tree.test.ts:113-145`: The mock intentionally returns the ORIGINAL parent as `baseRefName` rather than reading the live (mutated) state. Confirm this matches reality: GitHub returns whatever base the PR was opened against until `gh pr edit --base` fires. Without this snapshot, retarget assertions would be tautological (parent already equals current state).
2. **PR body refresh assertion scope** - `packages/cli/test/commands/post-merge-tree.test.ts:355-393`: `updateAllPrBodies` lives inside the mocked `submit()` so it is NOT exercised here. The test only proves `submit(cwd, false, { stack: true })` is invoked after retargeting — the mechanism that triggers PR body refresh. Bodies-by-output content is pinned by DUB-21's `pr-body.test.ts` snapshots.
3. **Cascade ordering** - `packages/cli/test/commands/post-merge-tree.test.ts:314-353`: Asserts that when `feat/base` (MERGED) and `feat/child` (MERGED, parent feat/base) are cleaned in the same pass, the surviving descendants (`feat/leaf` under feat/child, `feat/sib` under feat/base) both end up parented on `main`. Relies on `getMergedBottomBranches` adding feat/base first (parent satisfied = root), then feat/child (parent satisfied = merged), and on `planReparents` reading the live (already-updated) parent at delete time.
4. **Multi-sibling subtree boundary** - `packages/cli/test/commands/post-merge-tree.test.ts:267-310`: Verifies that when `feat/base` is cleaned, `feat/sib-a`/`feat/sib-b` reparent onto `main` but `feat/grand-a`/`feat/grand-b` keep their original parents and are NOT retargeted. Confirms the retarget set is scoped strictly to branches whose parent actually moved.

## Test plan

- [x] **unit:** S1 leaf merged — sibling untouched, no reparent, no retarget - post-merge-tree.test.ts:168-194 — `expect(mockRetargetPrBase).not.toHaveBeenCalled()`.
- [x] **unit:** S2 middle merged, single child — child reparented + retargeted to grandparent - post-merge-tree.test.ts:196-227 — retargetPrBase called once with `('feat/child', 'main', '/repo')`.
- [x] **unit:** S3 middle merged, multiple children — all three reparented + retargeted - post-merge-tree.test.ts:229-265 — retargetPrBase invoked exactly 3 times, all with newBase=main.
- [x] **unit:** S4 base merged, multi-sibling subtree — siblings reparent, grandchildren unchanged - post-merge-tree.test.ts:267-310 — grand-a/grand-b parent still equals sib-a/sib-b; retargets scoped to sib-a, sib-b only.
- [x] **unit:** S5 cascade — base + child both merged, leaf + sib both end up on root - post-merge-tree.test.ts:312-353 — cleaned=[base,child]; both leaf and sib reparented and retargeted to main.
- [x] **unit:** PR body refresh plumbing — stack-wide submit fires after cleanup - post-merge-tree.test.ts:355-393 — asserts submit called with `{ stack: true }` AFTER retargetPrBase via invocationCallOrder check.
- [x] **unit:** Surviving descendant checkout — user lands on a real branch - post-merge-tree.test.ts:395-411 — `checkoutBranch('feat/leaf', '/repo')` invoked when current branch was the merged feat/base.
- [x] **unit:** No regressions for linear stacks - post-merge.test.ts (519 lines, untouched) still passes — full repo run 768/768.

## Quality gates

- **Lint + format:** `pnpm checks` - passed (Checked 257 files in 37ms. No fixes applied.)
- **Type check:** `pnpm typecheck` - passed (tsc --noEmit across docs + dubstack — 2 successful, 2 total.)
- **Test suite:** `pnpm test` - passed (86 files, 768 tests, all green (was 761 before; +7 new).)
- **Focused suite:** `pnpm vitest run test/commands/post-merge-tree.test.ts` - passed (1 file, 7 tests, 132ms.)

## Self-QA

See [QA fallback evidence](.reports/dub-23-qa.md).

CLI test-only change — QA fallback records the gates that ran and what each new scenario proves.

- Leaf merged: only the leaf is cleaned; sibling parent unchanged; retargetPrBase NOT called.
- Middle/single-child: child reparented to grandparent; gh pr edit fires once.
- Middle/multi-child: all three children reparented in one pass; three retargets, all to main.
- Base/multi-sibling subtree: siblings reparent; grandchildren keep original parents; no spurious retargets.
- Cascade: feat/base + feat/child cleaned together; surviving descendants end up parented on the root.
- PR body refresh plumbing: post-cleanup submit called with `{ stack: true }`; retargets precede submit per invocationCallOrder.
- Surviving-descendant checkout: if user was on the merged branch, checkoutBranch lands them on the survivor.

## Acceptance criteria

- [x] New packages/cli/test/commands/post-merge-tree.test.ts covering all 5 tree scenarios. - post-merge-tree.test.ts — 5 scenario tests + 2 plumbing tests, all green.
- [x] Every still-open PR has the correct base after post-merge (verified via gh mock assertions). - Each scenario asserts `mockRetargetPrBase` was/was-not called with the expected `(branch, newBase, cwd)` triples.
- [x] PR body stack tables refreshed to reflect the new tree shape. - Plumbing test asserts `submit(cwd, false, { stack: true })` is invoked after cleanup; this routes through `updateAllPrBodies` (pinned by DUB-21's pr-body.test.ts snapshots). Invocation order asserted: retargets precede submit.
- [x] No regressions for linear stacks (existing post-merge.test.ts still passes). - post-merge.test.ts untouched; full repo run 768/768 (86 files).

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 4/0

- Reviewer (feature-dev:code-reviewer) returned no critical or major blocking findings.
- Minor (acknowledged, not addressed): cascade test asserts result.retargeted order via toEqual — relies on alphabetical sort in retargetOpenPrBranches:48 plus the chosen names happening to be alphabetical. Renaming would require a test update; left as-is to keep the assertion readable.
- Minor (acknowledged): PR body refresh test only proves `submit` was invoked, not that `updateAllPrBodies` ran — intentional, since updateAllPrBodies output is pinned by DUB-21's pr-body.test.ts snapshots and live-firing it here would require unmocking the entire submit chain.
- Minor (resolved by design): `mockPrState` snapshot-at-setup is intentional — mirrors gh API which returns the PR's stored base until edited.
- Minor (resolved by design): `findStackForBranch` works against state at `readState` time, before cleanup mutates it — verified for both 'user on surviving sibling' and 'user on the merged branch' setups.

## Dependencies

- **DUB-20 (tree-walking submit):** Done — merged (commit 52ae5ac in recent log).
- **DUB-21 (tree-shaped PR body + v1 metadata schema):** Done — merged (commit 2dd70fc in recent log). Provides the buildStackTable/buildMetadataBlock that the post-cleanup submit invokes to refresh PR bodies.
- **DUB-77 (post-merge cleanup-journal unification):** Tracked separately and intentionally out of scope per the issue description.

## Rollout

Test-only — zero production code paths changed. Merge unlocks confidence that any future change to `post-merge.ts` (e.g., the deferred DUB-77 journal unification) does not silently regress tree handling.

- **On merge - CI:** Existing CI runs `pnpm checks`, `pnpm typecheck`, `pnpm test`. The 7 new tests will run as part of `pnpm test` and gate future PRs.
- **Follow-up - DUB-77:** When the cleanup-journal unification lands, this suite will catch any regression in tree cleanup ordering or reparent fan-out.

## Commit

```text
test(post-merge): tree-shape coverage + cascade scenarios [DUB-23]
```
