# Self-QA fallback - DUB-16

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

Pure CLI sync-command behavior change. No `.tsx` files touched, no UI surface,
no browser-demoable behavior. The freshness cache is a quantitative timing
behavior on `git fetch` arguments, fully exercised by Vitest with mocked
`fetchBranches`.

## What was verified

- `partitionFreshBranches` returns `{ mustFetch, canSkip }`:
  - branches with no `last_synced_at` → `mustFetch`
  - branches synced < 5min ago → `canSkip`
  - branches synced ≥ 5min ago → `mustFetch`
  - branches with unparseable timestamps → `mustFetch` (defensive)
  - future timestamps (clock skew) → `mustFetch` (defensive)
  - `fresh: true` → all branches `mustFetch` (cache bypass)
  - boundary (exactly window-ms ago) → `mustFetch` (strict <)
- `sync` calls `fetchBranches(['root', ...mustFetch], cwd)` — trunks always
  fetched, `canSkip` branches absent from the fetch list.
- Cached branches receive a `BranchSyncOutcome` with `status: 'fresh'` and
  `action: 'cached'`, plus a distinct ⚡ emoji line.
- `printSyncSummary` includes a `${cached} fresh-cached` counter when any
  branches were cached.
- `--fresh` CLI flag forces a full fetch of every tracked branch regardless of
  cache age.
- Batched `gh pr list` still runs every sync — PR state remains the most
  volatile signal (verified in test "still runs the batched gh pr list when
  every branch is cached").
- Cleanup of merged branches still fires for cached branches — freshness gates
  only network fetch, never PR-state-driven cleanup.
- **Idempotency:** two consecutive `sync` calls produce only `['main']` in the
  second `fetchBranches` call. All non-trunk branches show as `fresh-cached`.
- **Regression fix:** `local-ahead` branches now stamp `last_synced_at` via
  `markBranchSynced(..., source: 'sync-noop')` so subsequent syncs can skip
  their fetch — without this, branches with local commits ahead of remote
  (the typical active-development state) would be re-fetched on every sync,
  silently violating the AC.
- **Regression fix:** `markBranchSynced` now stamps `last_synced_at` even on
  the early-return path where baseline metadata can't be resolved — same root
  cause as above for any branch without a resolvable parent ref.
- Existing sync behavior preserved: 38 prior tests in `sync.test.ts` still
  green, including parent-mismatch, force-reset, reconcile flow, cleanup with
  worktree skip, and patch-id merge detection.

## Evidence

- `pnpm checks` — clean (Biome 217 files).
- `pnpm typecheck` — clean across `dubstack` + `docs`.
- `pnpm test` — **619 tests passing across 75 files**. New tests:
  - `partitionFreshBranches` — 8 cases in `packages/cli/src/lib/sync/fresh.test.ts`.
  - `sync` fresh / last_synced_at caching — 8 cases in
    `packages/cli/src/commands/sync.test.ts` (partition, stale refetch, --fresh
    override, batched gh still runs, merged cleanup still fires, unparseable
    timestamp defensive path, **local-ahead idempotency regression**, and the
    **two-consecutive-syncs idempotency AC**).

## Follow-up flag

Perf AC: "Idempotent: re-running `dub sync` immediately completes in < 2s on a
30-branch stack." This is mechanical from the diff — second sync only does one
`git fetch <trunk>` plus one `gh pr list`, both single network round-trips —
but the wall-clock number must be measured on a real 30-branch repo and
recorded in the PR description.
