# DUB-14 Self-QA (non-browser fallback)

This is a CLI library change. No TSX or browser surface was modified, so Playwright video is not required. QA evidence below is the local automated test suite plus a description of how to exercise the new behavior manually.

## Automated suite

- `pnpm checks` (biome) — passes.
- `pnpm typecheck` — passes.
- `pnpm test` — 598 tests pass (73 files). 15 tests added for DUB-14.

## Scenarios exercised by automated tests

1. **Classifier — new statuses**: `branch-status.test.ts` covers
   `squash-merged-with-trailing-commits`, `parent-merged-orphan`,
   `remote-restacked`, and `non-conflicting-divergence` returning from
   `classifyBranchSyncStatus` for the expected inputs (and the inverse
   when triggers are absent).
2. **Sync command — auto-rebase**: With a diverged branch and a stubbed
   `rebaseBranchOntoRef` returning `true`, the sync emits
   `non-conflicting-divergence` / `synced` with reconcile source
   `sync-rebase-onto-remote`.
3. **Sync command — remote-restacked**: With PR `baseRefName` differing
   from the local parent and `origin/<new-parent>` being an ancestor of
   `origin/<branch>`, sync hard-resets the local branch, adopts the
   remote parent in state, and emits `remote-restacked` with source
   `sync-remote-restacked`.
4. **Sync command — parent-merged-orphan**: With parent's PR `MERGED`,
   cleanup deletes the parent and reparents children. The child branch
   then emits a `parent-merged-orphan` outcome with reconcile source
   `sync-parent-merged-reparent`.
5. **Sync command — squash + trailing**: With PR `MERGED` and the
   `isMergedByPatchId` fallback returning false (commits past squash
   boundary), cleanup tags the entry as
   `merged-pr-with-trailing-commits`. Sync emits a
   `squash-merged-with-trailing-commits` outcome with explicit recovery
   guidance, then deletes the branch.
6. **Refinement — silent adopt when SHAs equal (unsubmitted path)**:
   Confirms `updated-outside-dubstack-but-up-to-date` runs without
   prompting and records `sync-no-change`.
7. **Refinement — auto-FF + parent adopt when local subset**: With local
   behind remote and PR base differing from the local parent, sync
   auto-FFs the branch, adopts the remote parent, and emits
   `needs-remote-sync-safe` / `synced` with source
   `sync-adopt-remote-parent`.
8. **State migration**: Legacy `sync_source` values (`sync`,
   `sync-noop`, `sync-restack`) load as their new `ReconcileSource`
   equivalents.
9. **Support bundle**: Histogram is surfaced via the new `sync` source
   in `formatSupportBundleSummaryMarkdown`, with entries rendered in
   count-descending order.
10. **Last-sync persistence**: After a sync, `state.last_sync.timestamp`
    is set and `state.last_sync.reconcile_sources` contains the
    per-source count for the run.

## Manual smoke

The following manual checks are recommended before landing in trunk
(but are not required for review):

- Run `dub sync` against a stack with a squash-merged PR and a local
  commit added after the squash; confirm the warning about trailing
  commits surfaces and the branch is removed.
- Run `dub sync` against a stack where the remote PR base was
  retargeted; confirm the local parent is adopted in `.git/dubstack/state.json`
  and the outcome message names the new parent.
- Inspect `dub support` output to confirm the
  `Last Sync Reconcile Sources` section reflects the most recent sync.
