## TL;DR

Adds 4 sync statuses (remote-restacked, squash-merged-with-trailing-commits, non-conflicting-divergence, parent-merged-orphan), a 14-value `ReconcileSource` enum that replaces the legacy `sync_source` string, and a histogram of reconcile sources persisted to `state.last_sync` and surfaced via the support bundle. Includes refinements that auto-FF with parent adoption when local is a strict subset and auto-rebase non-conflicting divergence.

## Why

Support bundles and telemetry need to attribute every reconciliation to a specific decision path so we can debug sync regressions without source diving.

The 9-status taxonomy collapsed several distinct decisions into `reconcile-needed` and lost the signal users need to recover trailing commits or notice a remote restack.

Sync had no awareness of remote-side restacks or parent-PR merges; users had to manually retarget bases when remote moved underneath their stack.

### Before

- `BranchSyncStatus` had 9 values; remote-restacked / squash-trailing / parent-merged / non-conflicting cases all fell into `reconcile-needed` or were silently mis-classified.
- `sync_source` was the flat union `'submit' | 'sync' | 'imported'`; provenance was lost as soon as a branch was touched by sync.
- Support bundle had no signal about the last sync run — agents reproducing a bug had to ask the user what happened.

### After

- `BranchSyncStatus` now has 13 values, including dedicated statuses for remote-restacked, squash + trailing commits, parent-merged-orphan, and non-conflicting divergence.
- `ReconcileSource` is a 14-value union recorded on every per-branch outcome and persisted in `last_submitted_version.source`, `last_reconciled_version.source`, and `sync_source`.
- `state.last_sync.reconcile_sources` holds a per-sync histogram; the support bundle surfaces it under a new `sync` source in both data and markdown form.

## File-by-file

### packages/cli/src/lib/sync/types.ts

mod +43 / -0

Adds the 4 new `BranchSyncStatus` values, the full `ReconcileSource` union, a `RECONCILE_SOURCES` const tuple for iteration, a `ReconcileSourceHistogram` type, and extends `BranchSyncOutcome` and `SyncResult` to carry the reconcile source for each branch and the per-sync histogram.

```ts
export type ReconcileSource =
  | 'submit'
  | 'sync-no-change'
  | 'sync-adopt-remote-safe'
  | 'sync-adopt-remote-divergent'
  | 'sync-adopt-remote-parent'
  | 'sync-rebase-onto-remote'
  | 'sync-rebase-onto-parent'
  | 'sync-remote-restacked'
  | 'sync-parent-merged-reparent'
  | 'sync-squash-merged-cleanup'
  | 'sync-keep-local'
  | 'sync-skip'
  | 'sync-force'
  | 'imported';
```

### packages/cli/src/lib/sync/branch-status.ts

mod +46 / -0

Extends `classifyBranchSyncStatus` with optional inputs that let callers feed in PR base info, parent-PR-merged signal, remote ancestry of the new parent, an explicit `squashMergedWithTrailingCommits` flag, and a `rebaseOntoRemoteClean` trial result. The classifier returns one of the new statuses when the corresponding triggers are present and otherwise behaves as before.

```ts
if (input.squashMergedWithTrailingCommits) {
  return 'squash-merged-with-trailing-commits';
}
if (input.parentPrMerged) {
  return 'parent-merged-orphan';
}
// ...
if (remoteParentDiffers && input.remoteContainsNewParentHistory) {
  return 'remote-restacked';
}
if (input.rebaseOntoRemoteClean === true) {
  return 'non-conflicting-divergence';
}
```

### packages/cli/src/lib/sync/cleanup.ts

mod +9 / -1

Adds the new `merged-pr-with-trailing-commits` cleanup reason. When PR is MERGED and `isMergedByPatchId` is supplied, the helper now classifies the entry as having trailing commits whenever not every branch commit landed in trunk. The branch still gets deleted; the new reason lets the sync command surface a recovery message.

```ts
if (prState === 'MERGED') {
  let reason: CleanupReason = 'merged-pr';
  if (input.isMergedByPatchId) {
    const allInTrunk = await input.isMergedByPatchId(branch);
    if (!allInTrunk) reason = 'merged-pr-with-trailing-commits';
  }
  toDelete.push({ branch, reason });
  continue;
}
```

### packages/cli/src/lib/state.ts

mod +58 / -1

Updates `Branch` so the three reconciliation-related fields use the new `ReconcileSource` type, adds a `LastSyncSummary` record on `DubState`, and rewires the normalizer to migrate legacy values (`sync`, `sync-noop`, `sync-restack`, `sync-adopt-remote`) to their new equivalents while preserving `last_sync` only when present.

```ts
const LEGACY_RECONCILE_SOURCE_MAP: Record<string, ReconcileSource> = {
  sync: 'sync-adopt-remote-safe',
  'sync-adopt-remote': 'sync-adopt-remote-safe',
  'sync-noop': 'sync-no-change',
  'sync-restack': 'sync-rebase-onto-remote',
};
```

### packages/cli/src/commands/sync.ts

mod +251 / -7

Wires the new classifier inputs (remote base, parent ancestry), adds handlers for the 4 new statuses, records reconcile sources per outcome, tracks branches reparented due to a merged parent, attempts an auto-rebase trial for `reconcile-needed`, refines `needs-remote-sync-safe` to adopt the remote parent when the PR base moved, generalizes `markBranchSynced` to accept any `ReconcileSource`, and persists the per-sync histogram in `state.last_sync`.

```ts
state.last_sync = {
  timestamp: new Date().toISOString(),
  reconcile_sources: { ...result.reconcileSources },
};
await writeState(state, cwd);
```

### packages/cli/src/lib/support-bundle.ts

mod +58 / -3

Adds a `sync` source to the support bundle with `lastSyncAt` and a `reconcileSources` histogram. Markdown formatter renders the histogram in count-descending order under a new section.

```ts
async function defaultCollectSync(cwd: string): Promise<SupportSyncContext> {
  let state: DubState;
  try {
    state = await readState(cwd);
  } catch {
    return { lastSyncAt: null, reconcileSources: {} };
  }
  const lastSync = state.last_sync ?? null;
  return {
    lastSyncAt: lastSync?.timestamp ?? null,
    reconcileSources: lastSync?.reconcile_sources ?? {},
  };
}
```

### packages/cli/src/lib/sync/branch-status.test.ts

mod +77 / -0

Adds tests for each new status returned by the classifier, including the negative case where `rebaseOntoRemoteClean === false` stays on `reconcile-needed`.

### packages/cli/src/lib/sync/cleanup.test.ts

mod +26 / -0

Adds coverage for the new `merged-pr-with-trailing-commits` reason and confirms the plain `merged-pr` reason when patch-id reports all commits in trunk.

### packages/cli/src/commands/sync.test.ts

mod +271 / -0

Adds an `expanded status taxonomy` describe block with seven tests for the new statuses, refinements, and histogram persistence. Adds module mocks for `rebaseBranchOntoRef` and `isMergedByPatchId`.

### packages/cli/src/lib/state.test.ts

mod +49 / -1

Adds coverage for legacy reconcile-source migration on read.

### packages/cli/src/lib/support-bundle.test.ts

mod +26 / -0

Adds the new `sync` source to the fixture bundle and asserts the markdown formatter renders the histogram and last-sync timestamp.

## Where to focus review

1. **Auto-rebase is destructive on success** - `packages/cli/src/commands/sync.ts (reconcile-needed branch)`: The trial calls `rebaseBranchOntoRef`, which rewrites the local branch on success. A `console.log` precedes the call so the user sees it, but reviewers should confirm the behavior matches the DUB-14 spec (auto-rebase clean divergence) and that the message is clear enough.
2. **Legacy reconcile-source migration in normalizeBranch** - `packages/cli/src/lib/state.ts (LEGACY_RECONCILE_SOURCE_MAP)`: Older state files persisted `sync`, `sync-noop`, `sync-restack`, or `sync-adopt-remote`. Read-side migration maps each to a new value; reviewers should check the mapping doesn't change behavior of subsequent code paths (especially the `priorBaseline?.source ?? entry.sync_source ?? 'imported'` fallback in `markBranchSynced`).
3. **Refinement: needs-remote-sync-safe silently adopts parent** - `packages/cli/src/commands/sync.ts (needs-remote-sync-safe handler)`: When local is a strict subset of remote and the PR base differs, we auto-FF and adopt the remote parent. An explicit `console.log` is emitted before the mutation, but this is a non-interactive behavior change. Confirm it's the intended interpretation of the DUB-14 'auto-FF when remote superset' refinement.
4. **Histogram persistence in last_sync** - `packages/cli/src/commands/sync.ts (before writeState)`: We assign `state.last_sync` even when the loop short-circuits before populating outcomes. Reviewers should confirm the data shape is always valid (default `{}` is fine) and that downstream consumers (support bundle) handle the empty histogram case.

## Test plan

- [x] **unit:** Classifier returns each new status for its triggers (and stays put when triggers are absent) - branch-status.test.ts adds 5 new tests; full file 13 tests.
- [x] **unit:** Cleanup tags MERGED branches with trailing commits separately - cleanup.test.ts adds 2 new tests; full file 9 tests.
- [x] **integration:** Sync command emits each new status with correct action + reconcile source and persists last_sync - sync.test.ts adds 7 new tests in the `expanded status taxonomy (DUB-14)` describe block.
- [x] **unit:** State migration of legacy reconcile-source values on read - state.test.ts adds the 'migrates legacy reconcile source values on read' test.
- [x] **unit:** Support bundle markdown surfaces histogram and last-sync timestamp - support-bundle.test.ts adds the 'includes reconcile-source histogram in markdown when last sync exists' test.
- [ ] **manual:** Run `dub sync` against a stack with a squash-merged PR + trailing commits and confirm the warning + cleanup - Requires a live GitHub repo; outside CI scope.

## Quality gates

- **Format + lint:** `pnpm checks` - passed (biome check . — Checked 207 files. No fixes applied.)
- **Type check:** `pnpm typecheck` - passed (tsc --noEmit across docs + dubstack — 2 tasks successful.)
- **Unit + integration tests:** `pnpm test` - passed (vitest — 73 test files, 598 tests passed (15 added).)
- **Evals:** `pnpm evals` - skipped (DUB-14 does not change AI metadata or prompts. Per AGENTS.md §6, evals are only required when those change. Local provider is not configured in this workspace.)

## Self-QA

See [QA fallback evidence](.reports/dub-14-qa.md).

Test suite + manual smoke playbook captured in the QA fallback document.

- Classifier surfaces each of the 4 new statuses for its trigger inputs.
- Sync command auto-rebases non-conflicting divergence and records sync-rebase-onto-remote.
- Sync command adopts the remote parent on remote-restacked branches.
- Sync command emits a parent-merged-orphan outcome for children reparented during cleanup.
- Sync command emits a squash-merged-with-trailing-commits outcome with reflog recovery guidance.
- Sync command auto-FF + adopts parent on needs-remote-sync-safe with a moved PR base.
- Support bundle markdown shows the per-source histogram in descending order.

## Acceptance criteria

- [x] `BranchSyncStatus` extended with the 4 new statuses - packages/cli/src/lib/sync/types.ts — union now includes remote-restacked, squash-merged-with-trailing-commits, non-conflicting-divergence, parent-merged-orphan.
- [x] `classifyBranchSyncStatus` returns the right status for each scenario - branch-status.ts + branch-status.test.ts cover all four new statuses + negative cases.
- [x] Per-status handling in commands/sync.ts with default actions per the table - sync.ts handlers: remote-restacked (auto-take + adopt parent), parent-merged-orphan (reparent), squash-merged-with-trailing-commits (cleanup + warn), non-conflicting-divergence (auto-rebase).
- [x] `ReconcileSource` enum used in place of free-form strings - state.ts types reference ReconcileSource for last_submitted_version.source, last_reconciled_version.source, and sync_source; markBranchSynced uses the union; recorded per outcome.
- [x] Support bundle surfaces source histogram for the most recent sync - support-bundle.ts exposes a `sync` source with `reconcileSources`; markdown renders 'Last Sync Reconcile Sources' section.
- [x] Tests covering each new status (squash with trailing, remote-restacked, parent-merged-orphan, non-conflicting-divergence) - sync.test.ts — expanded status taxonomy describe block has 7 tests covering the 4 statuses + refinements + persistence.
- [x] Tests covering the refinements (silent adopt in unsubmitted; auto-FF when remote superset) - sync.test.ts — 'unsubmitted in non-interactive adopts silently when SHAs already equal' and 'needs-remote-sync auto-FFs and adopts remote parent when local is strict subset'.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 2/0

- Important: auto-rebase trial in reconcile-needed is destructive on success. Resolved by emitting a `console.log` before the rebase attempt so the user sees the mutation.
- Important: needs-remote-sync-safe silently adopts the remote parent in non-interactive mode. Resolved by emitting a `console.log` naming the new parent before the state mutation.
- Minor: the squash-merged-with-trailing-commits warning did not mention `git reflog`. Resolved by updating the message to explicitly point users at `git reflog` and `dub track`.

## Dependencies

- **DUB-6 — git cherry patch-id squash-merge detection:** Done — `isMergedByPatchId` is used as the trailing-commits detector in cleanup.

## Rollout

Pure CLI library change, no flag/gate required. State file shape is forward-compatible via legacy-value migration on read.

- **Pre-merge - Land PR #46 once review approves:** Branch passes lint, typecheck, and the full test suite locally; CI will re-run the same gates.
- **Post-merge - No follow-up required:** Existing state files migrate on first read via LEGACY_RECONCILE_SOURCE_MAP. New histogram is populated on the first sync after the upgrade.

## Commit

```text
feat(sync): expand status taxonomy + reconciliation source tags
```
