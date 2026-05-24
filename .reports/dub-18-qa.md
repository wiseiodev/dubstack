# Self-QA fallback - DUB-18

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

Pure CLI behavior change in the `dub sync` cleanup phase plus a new `dub continue`
resume path. No `.tsx` files touched, no UI surface, no browser-demoable
behavior. The new algorithm and journal are exercised by deterministic unit +
integration tests against a real temp git repo.

## What was verified

- `buildCleanupPlan` (DFS-greedy with eager re-parenting):
  - 3-deep stack `trunk → middle (MERGED) → child (OPEN)`: produces ordered
    operations `[reparent(child, middle→null), delete(middle)]`. The reparent
    op precedes the delete so the journal records the orphan rescue before the
    parent disappears.
  - Cascading: `trunk → m1 (MERGED) → m2 (MERGED) → leaf (OPEN)` reparents
    `leaf` directly onto trunk and deletes both `m1` and `m2`.
  - Bottom-up deletion order in a fully-merged chain: `m2` is deleted before
    `m1` so we never destroy an ancestor that still claims a child branch.
  - Empty-branch safety:
    - Empty branch with no PR → kept by default.
    - Empty branch with no PR + `--force` → deleted (`empty-branch` reason).
    - Empty branch with an `OPEN` PR → auto-deleted without `--force`.
  - Backwards compatibility: every prior cleanup test still passes
    (`merged-pr`, `closed-pr-merged-into-trunk`, `merged-by-patch-id`,
    trailing-commits variant, mixed-lifecycle batch, skip reasons).
- Cleanup journal (`.git/dubstack/cleanup-journal.json`):
  - Created lazily at the start of the cleanup phase, atomically written
    (tmp + rename) so a crash mid-write can't leave a half-flushed file.
  - Every operation appended **before** execution.
  - Deleted on successful completion of the cleanup phase.
  - `version: 1` validated on read; malformed/old-version payloads throw a
    `DubError` with recovery hints instead of being silently misinterpreted.
- `detectActiveOperation` reports `'cleanup'` when the journal is on disk and
  no rebase/restack is in flight; rebase/restack still take precedence so
  users finish their interactive operation first.
- `dub continue` (`resumeCleanup`):
  - Replays the journal idempotently: `delete` ops no-op when the branch is
    already gone, `reparent` ops no-op when state already matches.
  - On full replay, clears the journal so subsequent `dub continue` calls
    are no-ops.
  - Skips deletion of the currently-checked-out branch (git rejects `-D` on
    HEAD); the next fresh `dub sync` handles it once the user moves off.
- `dub abort` now clears the cleanup journal when `cleanup` is the active op.
- `gatherConflictContext` throws a clear `DubError` if invoked during a
  cleanup operation — cleanup replay can't produce merge conflicts so there
  is no context to gather and `--ai` would have nothing to resolve.
- `sync` end-to-end:
  - New plan shape (`operations` array with interleaved reparent/delete) is
    consumed in order; auto-clean warning still names dependent branches
    correctly using the in-plan reparent set.
  - `reparentedDueToMergedParent` is now derived from the plan (look-ahead
    to the matching `delete` op) instead of side effects of
    `removeBranchFromState`, preserving the existing `parent-merged-orphan`
    outcome and `sync-parent-merged-reparent` reconcile source.
  - `--force` propagates into the empty-branch safety rule.
  - All 50 existing sync tests still pass (worktree-skip, dependent-child
    warning, `feat/c` parent preservation in 3-deep stack, surviving-child
    refresh, parent_revision preservation, per-branch error isolation, etc.).

## Evidence

- `pnpm checks` — clean (Biome 225 files).
- `pnpm typecheck` — clean across `dubstack` + `docs`.
- `pnpm test` — **653 tests passing across 77 files**. New tests:
  - `packages/cli/src/lib/sync/cleanup.test.ts` — 6 new cases under
    "DFS-greedy with re-parenting": reparent-onto-grandparent, cascading
    reparent, empty-no-PR safety, empty-no-PR + force, empty-with-PR, and
    bottom-up greedy deletion order.
  - `packages/cli/test/lib/sync/journal.test.ts` — 3 cases for the journal
    primitives (record + clear, malformed rejection, no-op clear).
  - `packages/cli/test/lib/sync/cleanup-resume.test.ts` — 3 cases for
    idempotent replay against a real temp git repo (full replay deletes
    the branch and reparents state, second replay is a no-op, journal is
    cleared after successful replay).
  - `packages/cli/src/commands/continue.test.ts` — new case asserting
    `dub continue` dispatches to `resumeCleanup` when the active operation
    is `cleanup`.

## Follow-up flag

None. All acceptance criteria are covered by tests above.
