## TL;DR

Replace `dub sync`'s flat cleanup scan with a DFS-greedy algorithm that interleaves re-parent and delete ops, and journal every decision to `.git/dubstack/cleanup-journal.json` before execution so `dub continue` can replay it idempotently after a crash or Ctrl-C.

## Why

Cleanup ran as an undifferentiated flat scan: a merged middle branch deleted, its child was reparented as a side-effect — no plan, no log, no replay path.

If sync crashed or was cancelled mid-cleanup, the only recovery was to re-run `dub sync` and hope the second pass converged to the same answer.

Stacks with multi-branch chains where intermediate branches got merged didn't get the rest of the chain collapsed greedily — each branch survived independently until its turn came up.

### Before

- `buildCleanupPlan` returned `{ toDelete, skipped }` — a flat list with no awareness of parent/child relationships.
- Re-parenting happened implicitly inside `removeBranchFromState` when each delete was applied, with no journal of the decision.
- There was no `cleanup` active operation; an interrupted cleanup left the repo half-changed with no way to resume.

### After

- `buildCleanupPlan` walks the tree DFS from trunk children, deferring each deletable branch until its child blockers are also deletable, and emits an ordered `operations` list interleaving `reparent` and `delete` ops.
- `sync` writes every op to `.git/dubstack/cleanup-journal.json` *before* executing it; the journal is cleared only on full success.
- `detectActiveOperation` reports `cleanup` when the journal is left behind, and `dub continue` dispatches to `resumeCleanup` for idempotent replay (deletes no-op when the ref is gone, reparents no-op when state already matches, ghost state entries get swept). `dub abort` clears the journal.

## File-by-file

### packages/cli/src/lib/sync/cleanup.ts

mod +248 / -21

Rewrites `buildCleanupPlan` as a DFS-greedy walk with eager re-parenting. New optional `parentOf`, `isEmpty`, `force` inputs; returns an ordered `operations` list plus per-category `toDelete`/`toReparent`/`skipped`. Backwards compatible when `parentOf` is omitted (flat mode preserves prior behavior).

```ts
while (queue.length > 0) {
  const branch = queue.shift();
  if (branch == null) break;
  if (visited.has(branch) || deleted.has(branch)) continue;

  const reason = await getDeleteReason(branch);
  if (reason != null) {
    visited.add(branch);
    const liveChildren = (childrenOf.get(branch) ?? []).filter(
      (c) => !deleted.has(c),
    );
    pendingDelete.set(branch, { reason, blockers: new Set(liveChildren) });
    for (let i = liveChildren.length - 1; i >= 0; i--) {
      const child = liveChildren[i];
      if (!visited.has(child) && !deleted.has(child)) queue.unshift(child);
    }
    greedilyDeleteUnblocked();
    continue;
  }
  // ... reparent path releases old-parent blocker so greedy delete can fire
```

### packages/cli/src/lib/sync/journal.ts

new +108 / -0

New atomic append-only journal at `.git/dubstack/cleanup-journal.json`. `start` / `append` / `read` / `clear`; writes go through a tmp + rename so a crash mid-write can't leave a half-flushed file. `version: 1` validated on read.

```ts
const tmp = `${journalPath}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, journalPath);
```

### packages/cli/src/lib/sync/cleanup-resume.ts

new +113 / -0

Idempotent journal replay used by `dub continue`. Always cleans the state entry for a delete op (sweeps ghost entries from a crash between `git branch -D` and `writeState`), no-ops when the git ref or parent assignment is already gone/matching, and clears the journal after a successful pass.

```ts
if (op.type === 'delete') {
  const stateChanged = removeBranchFromStacks(state.stacks, op.branch);
  if (stateChanged) stateDirty = true;

  if (op.branch === currentBranch) {
    console.log(`⚠ Branch '${op.branch}' is currently checked out; left it in place. ...`);
    alreadyApplied.push(op);
    continue;
  }
  const exists = await branchExists(op.branch, cwd);
  if (!exists) { alreadyApplied.push(op); continue; }
  await deleteBranch(op.branch, cwd);
  applied.push(op);
}
```

### packages/cli/src/commands/sync.ts

mod +95 / -36

Threads stack `parentOf`, `--force`, and an `isEmpty` check (via `hasUniquePatchCommits`) into `buildCleanupPlan`. Iterates the returned `operations` list in order, journaling each op before applying it, then calls `clearCleanupJournal` on success. Auto-clean warning now derives dependent branches from the in-plan reparent set; `reparentedDueToMergedParent` derives from a look-ahead at the matching `delete` op.

```ts
const cleanupJournal = await startCleanupJournal(cwd);
for (const op of cleanupPlan.operations) {
  if (op.type === 'reparent') {
    await appendCleanupOperation(cwd, cleanupJournal, op);
    const stateEntry = stateBranchMap.get(op.branch);
    if (stateEntry) stateEntry.parent = op.newParent;
    reparentedBranchNames.add(op.branch);
    // ... mark orphan-due-to-merged-parent
    continue;
  }
  // delete: log, journal, checkout, deleteBranch, drop state entry
}
await clearCleanupJournal(cwd);
```

### packages/cli/src/lib/operation-state.ts

mod +3 / -1

Adds `'cleanup'` to `ActiveOperation` and reports it from `detectActiveOperation` when the journal is present and no rebase/restack is in flight (rebase/restack still take precedence).

```ts
if (await hasRestackProgress(cwd)) return 'restack';
if (await hasGitRebaseInProgress(cwd)) return 'rebase';
if (await hasCleanupJournal(cwd)) return 'cleanup';
return 'none';
```

### packages/cli/src/commands/continue.ts

mod +8 / -1

Dispatches to `resumeCleanup` when the active operation is `cleanup` and surfaces the replay result on the command return value.

```ts
if (active === 'cleanup') {
  const cleanupResult = await resumeCleanup(cwd);
  return { continued: 'cleanup', cleanupResult };
}
```

### packages/cli/src/commands/abort.ts

mod +6 / -1

Clears the cleanup journal when the user aborts a pending cleanup, so the next `dub sync` starts from scratch instead of replaying.

```ts
if (active === 'cleanup') {
  await clearCleanupJournal(cwd);
}
```

### packages/cli/src/lib/conflict-context.ts

mod +11 / -0

Throws a clear `DubError` if conflict-context is invoked during a cleanup operation — cleanup replay can't produce merge conflicts so there's nothing for `--ai` to resolve.

```ts
if (operation === 'cleanup') {
  throw new DubError(
    'Cleanup replay does not produce merge conflicts requiring AI resolution.',
    ["Run 'dub continue' to replay the pending cleanup journal.", "Run 'dub abort' to discard the pending cleanup journal."],
  );
}
```

### packages/cli/src/lib/sync/cleanup.test.ts

mod +134 / -0

Adds a `DFS-greedy with re-parenting` describe block: 3-deep stack reparents child onto grandparent, cascading reparent through multiple merged ancestors, empty-branch safety with and without `--force`, bottom-up greedy deletion order.

### packages/cli/test/lib/sync/journal.test.ts

new +75 / -0

Integration tests against a real temp git repo: journal records ops in order then clears, malformed payloads are rejected with a clear DubError, no-op clear is safe.

### packages/cli/test/lib/sync/cleanup-resume.test.ts

new +197 / -0

End-to-end replay tests: full replay deletes the branch and reparents state, ghost state entry is swept when the branch ref is already gone, idempotent second replay is a no-op, journal is cleared after a successful pass.

### packages/cli/src/commands/continue.test.ts

mod +21 / -1

Asserts `dub continue` dispatches to `resumeCleanup` and returns the replay payload when active operation is `cleanup`.

### packages/cli/src/commands/abort.test.ts

mod +18 / -0

Asserts `dub abort` clears the cleanup journal and reports `aborted: 'cleanup'` when the active operation is `cleanup`.

### packages/cli/src/commands/sync.test.ts

mod +15 / -0

Adds `hasUniquePatchCommits` to the git mock and mocks the new journal module so the 50 existing sync tests continue to pass unchanged against the new ops-based cleanup loop.

### .reports/dub-18-qa.md

new +60 / -0

Self-QA fallback document — non-browser CLI change, deterministic vitest evidence in lieu of a video.

## Where to focus review

1. **DFS-greedy algorithm correctness** - `packages/cli/src/lib/sync/cleanup.ts:170-240`: Verify the reparent path releases the old parent's blocker (so greedy delete can collapse the chain), and the walk-up-to-non-deleted helper correctly skips both deleted and pending-delete ancestors.
2. **Crash-safety of the journal write path** - `packages/cli/src/lib/sync/journal.ts:97-108`: Writes go through tmp + atomic rename so a partial flush can't poison the next `dub continue`. Worth double-checking the version validation on read rejects old/unknown shapes loudly.
3. **Idempotent replay sweeps ghost state** - `packages/cli/src/lib/sync/cleanup-resume.ts:54-78`: A crash between `git branch -D` and `writeState` in the original sync can leave the state entry pointing at a now-missing branch. Replay must clean that ghost entry unconditionally — covered by the new `drops a ghost state entry` test.
4. **Existing `dub sync` UX preserved** - `packages/cli/src/commands/sync.ts:300-395`: Auto-clean dependent-branch warning, `parent-merged-orphan` outcome, and `sync-parent-merged-reparent` reconcile source must keep working under the new ops-based loop. Covered by the 50 prior sync tests still passing.

## Test plan

- [x] **unit:** DFS-greedy cleanup algorithm cases (6 new + 9 existing) - packages/cli/src/lib/sync/cleanup.test.ts — `buildCleanupPlan` + `DFS-greedy with re-parenting` describe blocks.
- [x] **integration:** Journal round-trip and replay against a real temp git repo (7 cases) - packages/cli/test/lib/sync/journal.test.ts (3) + packages/cli/test/lib/sync/cleanup-resume.test.ts (4).
- [x] **unit:** `dub continue` / `dub abort` cleanup dispatch - packages/cli/src/commands/continue.test.ts + packages/cli/src/commands/abort.test.ts — new `cleanup` operation cases.
- [x] **unit:** Existing `dub sync` behavior preserved end-to-end - packages/cli/src/commands/sync.test.ts — 50 cases including dependent-child warning, surviving-child refresh, parent_revision preservation, per-branch error isolation.

## Quality gates

- **biome lint + format:** `pnpm checks` - passed (Checked 225 files in 47ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (tsc --noEmit clean for `dubstack` and `docs` packages.)
- **vitest:** `pnpm test` - passed (655 tests passing across 77 files (was 639 / 75 pre-DUB-18).)

## Self-QA

See [QA fallback evidence](.reports/dub-18-qa.md).

Self-QA fallback for the new cleanup algorithm, journal, and continue/abort dispatch — all AC items covered by tests.

- 3-deep stack with middle merged → child reparented onto trunk, middle deleted (cleanup.test.ts).
- Cascading reparent through multiple merged ancestors → leaf attaches to trunk (cleanup.test.ts).
- Empty branch with no PR is preserved by default; deleted only with `--force` (cleanup.test.ts).
- Journal records every decision before execution and clears on success (journal.test.ts).
- `dub continue` replays the journal idempotently: ghost state entries swept, no-op on second replay (cleanup-resume.test.ts).
- `dub abort` clears the cleanup journal (abort.test.ts).

## Acceptance criteria

- [x] `buildCleanupPlan` in `lib/sync/cleanup.ts` implements DFS-greedy with eager re-parenting - packages/cli/src/lib/sync/cleanup.ts — DFS queue starts at trunk children, recurses into a deletable parent's children, eager-deletes when blockers clear.
- [x] Branches whose blocking children are deleted are themselves immediately deleted - `greedilyDeleteUnblocked` iterates `pendingDelete` and deletes any entry whose blocker set is empty; verified by `greedy-deletes a chain when both ancestor and child are merged` test.
- [x] Re-parented orphans correctly attach to nearest non-deleted ancestor - `walkUpToNonDeleted` skips both deleted and pending-delete ancestors; verified by `re-parents an open child onto the grandparent` and `cascades reparenting through several merged ancestors`.
- [x] Empty branches without PRs are NOT auto-deleted unless `--force` - `getDeleteReason` only returns `empty-branch` for `NONE`-PR branches when `input.force === true`. Verified by `does not delete an empty branch with no PR by default` and `deletes an empty branch with no PR when --force is set`.
- [x] `.git/dubstack/cleanup-journal.json` records every cleanup decision before execution - `sync.ts` calls `appendCleanupOperation` before each `deleteBranch` / state mutation. Verified by `records operations in order and clears on success` in `journal.test.ts`.
- [x] `dub continue` replays the journal idempotently - `resumeCleanup` no-ops when the branch ref or parent assignment is already in the target state; ghost state entries get swept. Verified by `is idempotent: a second replay ... is a no-op` and `drops a ghost state entry` in `cleanup-resume.test.ts`.
- [x] Tests: 3-deep stack with middle merged → child re-parented onto grandparent, middle deleted - `re-parents an open child onto the grandparent when the middle is merged` in cleanup.test.ts asserts ordered `[reparent, delete]` ops.
- [x] Tests: interruption mid-cleanup → `dub continue` resumes from journal - `replays a journal: reparents a child and deletes the merged middle` in cleanup-resume.test.ts simulates a paused cleanup and verifies branch ref + state both reach the intended end state.
- [x] Tests: empty-branch safety rule - Both branches of the rule (no-force keeps, force deletes) are covered in cleanup.test.ts.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Critical (fixed): `dropBranchFromState` after a `delete` op only removed the entry without forwarding children. Combined with a crash between `git branch -D` and `writeState`, replay would leave a ghost state entry pointing at a missing branch — fixed by always sweeping the entry in `resumeCleanup` and adding the `drops a ghost state entry` test.
- Important (fixed): `abort.test.ts` had no coverage for the new `cleanup` operation — fixed by adding `aborts a pending cleanup by clearing the journal`.
- Minor: when the journal references the user's current HEAD branch, replay skips the git delete (state is still swept). A clearer warning is now printed; the next `dub sync` will re-plan and delete once the user moves off.

## Dependencies

- **DUB-1 — Universal recovery hints in DubError:** Done (landed)
- **DUB-14 — Expand sync status taxonomy + reconciliation source tags:** Done (landed)

## Rollout

Source-only change in the CLI package — no migration, no flag, ships with the next `dub` release.

- **Merge - Land on `main`:** Squash-merge the PR. No data migration; `.git/dubstack/cleanup-journal.json` is created on demand and cleaned up after each successful sync.
- **Post-merge - Verify on a real stack:** Run `dub sync` on a stack with a merged middle branch; confirm the child reparents and the middle is deleted with the `↪ Reparenting … onto …` log line.

## Commit

```text
feat(sync): dfs-greedy cleanup with eager reparenting + journal replay [DUB-18]
```
