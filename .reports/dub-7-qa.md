# Self-QA fallback - DUB-7

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

Pure CLI library + command refactor. No `.tsx` files changed, no UI surface, no
browser-demoable behavior. Behavior is fully exercised by Vitest unit tests
mocking `execa`/`gh`.

## What was verified

- `getAllPrSyncInfoBatch` returns a `Map<headRefName, BranchPrSyncInfo>` with
  correctly classified state (OPEN/CLOSED/MERGED/NONE) and `baseRefName`.
- The helper issues a single `gh pr list --state all --json ... --limit 100`
  call with the exact JSON field set required by the issue spec, plus future
  callers (`dub log`, `dub doctor`).
- Duplicate-branch entries (multiple PRs ever opened against the same head) keep
  the first (most-recent) PR, matching prior `.[0]`-jq semantics.
- `truncated` is `true` when raw response length reaches the limit; `false`
  otherwise. Documented rationale for counting raw entries rather than unique
  branches.
- `sync` calls the batch once, then `lookupPrSyncInfo` returns cached info
  without any per-branch `gh pr list --head` round-trips when not truncated.
- Truncation fallback: when the batch is flagged truncated and a branch is
  absent from the map, `sync` falls back to the per-branch `getBranchPrSyncInfo`.
- Merged-branch cleanup driven entirely from the batched map deletes the branch
  and emits the expected `cleaned` outcome with zero per-branch calls.
- `getBranchPrSyncInfo` and `getBranchPrLifecycleState` exports preserved for
  `doctor`, `post-merge`, `merge-next`, and `stack-maintenance`.

## Evidence

- `pnpm checks` — clean (Biome lint + format across 188 files).
- `pnpm typecheck` — passes for both `dubstack` and `docs` packages.
- `pnpm test` — 508 tests passing across 68 files. New tests:
  - `getAllPrSyncInfoBatch` — 6 cases in `packages/cli/src/lib/github.test.ts`
    (classify state, command shape, empty list, truncation flag, duplicate
    branch dedupe, gh failure wrapped in `DubError`).
  - `sync` batched PR sync info — 3 cases in
    `packages/cli/src/commands/sync.test.ts` (cached map used + no per-branch
    calls, merged-branch cleanup via map, truncation fallback fires
    `getBranchPrSyncInfo`).

## Follow-up flag

Perf number for the acceptance criterion "30-branch sync drops by ≥ 20 seconds"
is not recorded here — needs a real 30-branch repo measurement. Code change is
the same single-call vs. N-call refactor described in the issue, so the
expected delta is mechanical. Will record in the PR description once measured.
