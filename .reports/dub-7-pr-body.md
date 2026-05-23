## TL;DR

`dub sync` now fetches PR state for every branch in one `gh pr list` call instead of one per branch, with a per-branch fallback when the batch hits the page limit.

## Why

A 30-branch stack sync was paying 25–35 seconds in serial `gh pr list --head` round-trips.

Same batched data layer will be reused by `dub log` (Tier 2) and `dub doctor` (DUB-25, DUB-64).

### Before

- `sync` called `getBranchPrLifecycleState` per branch for cleanup classification, then `getBranchPrSyncInfo` per branch for parent-mismatch detection — 2N gh round-trips on a clean run.
- Each call funneled through `gh pr list --head <branch> --state all --json ... --jq .[0]`.

### After

- `getAllPrSyncInfoBatch` issues exactly one `gh pr list --state all --json number,headRefName,baseRefName,state,mergedAt,reviewDecision,statusCheckRollup --limit 100` and returns a `Map<headRefName, BranchPrSyncInfo>` plus a `truncated` flag.
- `sync.ts` calls the batch once and a local `lookupPrSyncInfo` resolves every branch from the map. Per-branch `getBranchPrSyncInfo` is only invoked when the map is missing the branch AND the batch reported truncation.

## File-by-file

### packages/cli/src/lib/github.ts

mod +107 / -0

Adds `AllPrSyncInfoBatch` interface, the `BATCH_PR_LIST_LIMIT` constant, the `getAllPrSyncInfoBatch` helper, and the internal `classifyPrState` mapper. Helper sorts by gh default (recency) and keeps the first PR per `headRefName` to match prior `.[0]`-jq semantics. Truncation is signalled when the raw response length reaches the limit (documented why we don't count unique branches).

```ts
export async function getAllPrSyncInfoBatch(
  cwd: string,
): Promise<AllPrSyncInfoBatch> {
  // ... single `gh pr list --state all ... --limit 100` call
  for (const entry of parsed) {
    if (byBranch.has(head)) continue; // first wins → most recent PR
    byBranch.set(head, {
      state: classifyPrState(record.state, record.mergedAt),
      baseRefName: record.baseRefName ?? null,
    });
  }
  return { byBranch, truncated: parsed.length >= BATCH_PR_LIST_LIMIT };
}
```

### packages/cli/src/commands/sync.ts

mod +14 / -2

Calls `getAllPrSyncInfoBatch` once after the cleanup-eligible branch list is built. Replaces both the cleanup-plan `getPrStatus` callback and the per-branch reconcile lookup with a single `lookupPrSyncInfo` that consults the map first and only falls back to `getBranchPrSyncInfo` when the batch reported truncation. Removes the now-unused `getBranchPrLifecycleState` import.

```ts
const prBatch = await getAllPrSyncInfoBatch(cwd);
const lookupPrSyncInfo = async (
  branch: string,
): Promise<BranchPrSyncInfo> => {
  const cached = prBatch.byBranch.get(branch);
  if (cached) return cached;
  if (prBatch.truncated) return getBranchPrSyncInfo(branch, cwd);
  return { state: 'NONE', baseRefName: null };
};
```

### packages/cli/src/lib/github.test.ts

mod +127 / -0

Six new cases covering: state classification across OPEN/CLOSED/MERGED; exact gh command shape with the documented JSON fields; empty list; truncation flag when length hits the limit; duplicate-branch dedupe keeping the first entry; gh failure wrapped in `DubError`.

### packages/cli/src/commands/sync.test.ts

mod +98 / -11

Mocks `getAllPrSyncInfoBatch` with an empty/truncated default so existing per-branch fallback tests keep working. Adds a `batched PR sync info` describe block with three cases: cached map hit asserts zero per-branch gh calls; merged-branch cleanup driven entirely from the map; truncated-batch fallback fires `getBranchPrSyncInfo`. Rewrites four existing tests that previously mocked `getBranchPrLifecycleState` to mock `getBranchPrSyncInfo` instead (cleanup now reads state from the sync-info path).

## Where to focus review

1. **Truncation signal** - `packages/cli/src/lib/github.ts:303`: We count raw entries, not unique branches, on purpose. Comment explains the rationale: counting unique branches would miss the case where many PRs cluster on few branches and other branches' older PRs are off the page.
2. **Fallback wiring** - `packages/cli/src/commands/sync.ts:201-209`: `lookupPrSyncInfo` is the single chokepoint for both cleanup classification and per-branch reconcile. Worth confirming both call sites use it consistently and the NONE short-circuit is safe when the batch wasn't truncated.
3. **Default mock semantics in sync tests** - `packages/cli/src/commands/sync.test.ts:160-165`: Default sets `truncated: true` so historical tests that mock `getBranchPrSyncInfo` still exercise the fallback path unchanged. New `batched PR sync info` block explicitly overrides this to test the primary batch path.

## Test plan

- [x] **unit:** getAllPrSyncInfoBatch — 6 cases (classify, command shape, empty, truncation, dedupe, failure) - packages/cli/src/lib/github.test.ts (new describe block)
- [x] **unit:** sync — batched PR sync info (cached hit, merged cleanup via map, truncated fallback) - packages/cli/src/commands/sync.test.ts (new describe block at end of file)
- [x] **unit:** Existing sync tests continue to pass through the per-branch fallback path - pnpm test: 68 files / 508 tests passing
- [ ] **manual:** 30-branch sync wall-clock measurement against a real repo (acceptance criterion) - Needs a real 30-branch stack to time. Mechanical refactor — expected delta ≥ 20s. Will record in PR description once measured.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (Checked 188 files in 49ms. No fixes applied.)
- **Type check (turbo: docs + dubstack):** `pnpm typecheck` - passed (2 successful, 2 total. dubstack ran tsc --noEmit; docs cache hit.)
- **Vitest suite:** `pnpm test` - passed (Test Files 68 passed (68); Tests 508 passed (508); Duration 6.29s.)

## Self-QA

See [QA fallback evidence](.reports/dub-7-qa.md).

Self-QA fallback covering the batch helper, sync rewiring, and gate runs.

- Batch helper returns correctly classified map with expected gh command shape.
- sync uses cached map and skips per-branch gh calls when not truncated.
- sync falls back to getBranchPrSyncInfo when batch reports truncation and branch is missing.
- Merged-branch cleanup driven entirely from the batched map deletes the branch.
- All 508 existing tests still pass via the truncated-default fallback path.

## Acceptance criteria

- [x] `getAllPrSyncInfoBatch` exported from `lib/github.ts` - packages/cli/src/lib/github.ts — `export async function getAllPrSyncInfoBatch`.
- [x] Returns a `Map<branchName, BranchPrSyncInfo>` with all open + recent merged/closed PRs - Calls `gh pr list --state all --limit 100` and builds `byBranch` keyed by `headRefName`. Tested in `github.test.ts`.
- [x] `commands/sync.ts` uses it instead of per-branch `getBranchPrSyncInfo` calls - `lookupPrSyncInfo` consults the batch first; per-branch path is fallback-only. Asserted by `uses the batched map and skips per-branch gh calls when not truncated`.
- [x] Existing `getBranchPrSyncInfo` kept for callers that need a single branch - Function still exported. Callers in `doctor.ts:219`, `post-merge.ts:198`, `stack-maintenance.ts:19` untouched.
- [x] Tests: batch returns correct map, sync uses cached info, fallback if `gh` returns paginated truncation warning - github.test.ts has 6 batch cases incl. truncation; sync.test.ts has 3 cases incl. truncation fallback.
- [ ] Measured perf: 30-branch sync drops by ≥ 20 seconds on a real repo (record in PR description) - Cannot be measured from this repo (no 30-branch stack available). Refactor is mechanically N→1 calls — each saved round-trip is ~0.8–1.2s of gh API time, so 30 branches → ~24–36s saved, matching the spec's 25–35s estimate. Reviewer to run `time dub sync` on a real 30-branch stack and append the wall-clock delta to the PR description before merge.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 3/0

- Reviewer flagged that `truncated` counts raw entries instead of unique branches. Kept current behavior intentionally — sizing on `byBranch.size` would produce false negatives when many PRs cluster on few branches. Added an inline comment documenting the choice.
- Reviewer raised a hypothetical GHE scenario where `gh pr list --state all` is date-windowed. The prior `getBranchPrSyncInfo` issues the same `gh pr list --state all` (with `--head` filter), so any GHE windowing affects both paths identically — no behavioral regression vs. the prior code.
- Reviewer noted multi-branch dependent-children cleanup tests now run via the fallback path. Coverage is preserved (those tests still assert the same outcome) and a new dedicated batch-path cleanup test asserts the primary path. Adding a batch-path companion for every legacy test would duplicate behavior without uncovering new bugs.

## Dependencies

- **No external dependencies:** No external dependencies detected — issue is unblocked per Linear `blockedBy` empty.

## Rollout

Drop-in performance change. Same gh CLI surface, same DubError messages, same sync state-machine outcomes. No flag, no migration.

- **Merge - Land via standard squash merge:** Picked up by `dub sync` on next release. No env/flag/config knobs.
- **Post-merge - Measure perf on a 30-branch repo:** Time `dub sync` against a 30-branch stack before/after this commit and append the delta to the PR description / Linear issue.
- **Follow-up - Reuse the batch helper in `dub log` and `dub doctor`:** Covered by DUB-25 (Batched PR/CI data layer for log and checkout) and DUB-64 (Parallelization helper). `getAllPrSyncInfoBatch` already returns a Map keyed by headRefName ready to consume.

## Commit

```text
feat(sync): batched gh pr list to replace N per-branch calls
```
