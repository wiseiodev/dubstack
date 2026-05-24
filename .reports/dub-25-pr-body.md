## TL;DR

Adds `getStackOverviewBatch` in `lib/stack-overview.ts`: one `gh pr list` (rich fields) + one `git for-each-ref` (commit metadata), joined with Dubstack state, cached for 30 s at `.git/dubstack/overview-cache.json`. `--refresh` busts the cache; truncation flag flows through; cache writes are best-effort so a read-only `.git` cannot crash callers.

## Why

Tier 2 views (`dub log`, `dub co`, `dub status`, `dub watch`) need richer PR data (title, draft, reviewDecision, CI rollup, last-commit relative time) than the existing `getAllPrSyncInfoBatch` returns.

Without batching, each branch in a stack costs one `gh pr view` + one `git log` round-trip — O(N) latency that gets painful past a handful of branches.

Repeated invocations in a short window (e.g. `dub log` followed immediately by `dub co`) should not re-hit GitHub — hence the 30 s on-disk cache.

### Before

- `getAllPrSyncInfoBatch` returned only `{state, baseRefName}` — fine for sync, insufficient for richer UI views.
- No batched git helper for commit metadata: callers were forced to loop `getLastCommitMessage` per branch.
- No on-disk cache. Every TUI tick that wanted the overview paid the full fetch cost.

### After

- `getStackOverviewBatch(cwd, { refresh? })` returns a materialized `StackOverview` joining PR + commit + Dubstack state for every tracked branch.
- One `gh pr list` (richer `--json` field set) + one `git for-each-ref` regardless of stack size.
- 30 s TTL on-disk cache at `.git/dubstack/overview-cache.json`; `refresh: true` (or stale / future-dated `cachedAt`) busts it.
- Truncation passthrough: when `gh pr list` hits the page limit, the consumer learns and can render an 'N of N+' notice.
- Cache write is best-effort — a read-only or full `.git` directory can't crash the caller after the fetch already succeeded.

## File-by-file

### packages/cli/src/lib/stack-overview.ts

new +150 / -0

New orchestrator. `getStackOverviewBatch` reads the on-disk cache (rejects negative ages from clock skew), and on a miss runs `getStackOverviewPrBatch` + `getBranchCommitMetaBatch` in parallel, joins each tracked branch with state fields (`pr_link`, `last_synced_at`, `sync_source`), and writes the result back to `.git/dubstack/overview-cache.json`. The write is wrapped in try/catch so disk failures don't propagate.

```ts
export async function getStackOverviewBatch(
  cwd: string,
  options: GetStackOverviewOptions = {},
): Promise<StackOverview> {
  const now = options.now?.() ?? Date.now();

  if (!options.refresh) {
    const cached = await readCache(cwd);
    if (cached) {
      const age = now - Date.parse(cached.cachedAt);
      if (Number.isFinite(age) && age >= 0 && age < OVERVIEW_CACHE_TTL_MS) {
        return cached;
      }
    }
  }

  const state = await readState(cwd);
  const allBranchNames = state.stacks.flatMap((s) => s.branches.map((b) => b.name));
  const [prBatch, commitBatch] = await Promise.all([
    getStackOverviewPrBatch(cwd),
    getBranchCommitMetaBatch(cwd, allBranchNames),
  ]);
```

### packages/cli/src/lib/github.ts

mod +170 / -0

Adds `getStackOverviewPrBatch` — richer cousin of `getAllPrSyncInfoBatch` that pulls `number,title,headRefName,baseRefName,state,mergedAt,reviewDecision,statusCheckRollup,isDraft` and rolls the mixed CheckRun + StatusContext array up to a single `CiStatusRollup` (FAILURE > PENDING > SUCCESS). Kept separate from the existing sync helper so its tight field set and parser tests stay untouched.

```ts
export async function getStackOverviewPrBatch(
  cwd: string,
): Promise<StackOverviewPrBatch> {
  // ... one `gh pr list --json ...` call ...
}

function computeCiRollup(checks: unknown): CiStatusRollup {
  // FAILURE dominates PENDING dominates SUCCESS.
}
```

### packages/cli/src/lib/git.ts

mod +68 / -0

Adds `getBranchCommitMetaBatch(cwd, branchNames)` — one `git for-each-ref` call over `refs/heads/<branch>` for each requested branch. Fields are joined by ASCII unit-separator (`\x1f`) so spaces inside `committerdate:relative` and angle brackets inside `authoremail` can't break parsing. Missing-locally branches are simply absent from the returned map.

```ts
export async function getBranchCommitMetaBatch(
  cwd: string,
  branchNames: readonly string[],
): Promise<Map<string, BranchCommitMeta>> {
  const refs = branchNames.map((name) => `refs/heads/${name}`);
  const format =
    `%(refname:short)${SEP}%(committerdate:relative)${SEP}` +
    `%(authoremail)${SEP}%(objectname:short=8)`;
  // ...
}
```

### packages/cli/src/lib/stack-overview.test.ts

new +252 / -0

9 tests covering: fresh fetch (single gh + single for-each-ref, joined correctly), null pr/commit for unmatched branches, cache hit, cache stale, refresh override, on-disk persistence, future-dated cache rejection, truncation passthrough, and cache-write-failure resilience.

### packages/cli/src/lib/github.test.ts

mod +192 / -0

6 new tests for `getStackOverviewPrBatch`: rich field parsing, exact gh args, CI rollup precedence (PENDING/SUCCESS/NONE), truncation, duplicate-PR handling, and gh failure path.

### packages/cli/src/lib/git.test.ts

mod +41 / -0

3 new tests for `getBranchCommitMetaBatch`: empty input, two-branch parse against a real test repo, and missing-branch handling.

## Where to focus review

1. **Cache TTL logic and clock-skew handling** - `packages/cli/src/lib/stack-overview.ts:97-105`: The freshness check rejects negative ages so a future-dated `cachedAt` (e.g. NTP correction) can't pin us to stale data indefinitely. Worth a second look that the comparison is right and the test covers it.
2. **CI rollup precedence** - `packages/cli/src/lib/github.ts:531-577`: GitHub mixes CheckRun (`status`/`conclusion`) and StatusContext (`state`) shapes in the same `statusCheckRollup` array. The rollup handles both shapes and gives FAILURE > PENDING > SUCCESS precedence.
3. **Cache write resilience** - `packages/cli/src/lib/stack-overview.ts:131-138`: Added after adversarial review: a read-only or full `.git` directory must not crash callers after the fetch already succeeded. Covered by `stack-overview.test.ts > cache write failure`.

## Test plan

- [x] **unit:** stack-overview.test.ts — 9 tests - All 9 tests pass via `pnpm vitest run src/lib/stack-overview.test.ts`.
- [x] **unit:** github.test.ts — getStackOverviewPrBatch (6 new tests) - All 55 github.test.ts tests pass.
- [x] **unit:** git.test.ts — getBranchCommitMetaBatch (3 new tests, real git repo) - All 55 git.test.ts tests pass.
- [ ] **manual:** End-to-end exercise via dub log / dub co - Deferred to DUB-26 which wires this data layer into the renderers.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (`Checked 263 files in 52ms. No fixes applied.`)
- **TypeScript:** `pnpm typecheck` - passed (tsc --noEmit succeeded for both `dubstack` and `docs` packages.)
- **Vitest:** `pnpm test` - passed (87 test files, 806 tests passed.)

## Self-QA

See [QA fallback evidence](.reports/dub-25-qa.md).

Self-QA fallback documenting which automated test covers each acceptance criterion.

- Fresh fetch — one gh + one for-each-ref, state joined.
- Cache hit within TTL — no gh/git calls.
- Cache stale past TTL — refetch.
- Refresh override — refetch even when fresh.
- Future-dated cache — rejected.
- Truncation passthrough — flag flows through.
- Cache write failure — overview still returned.

## Acceptance criteria

- [x] `getStackOverviewBatch` exported from `lib/stack-overview.ts` - stack-overview.ts:79 export.
- [x] One `gh pr list` + one `git for-each-ref` for the whole stack - stack-overview.test.ts > 'issues one gh call + one for-each-ref' asserts call counts == 1.
- [x] 30-second on-disk TTL cache at `.git/dubstack/overview-cache.json` - `OVERVIEW_CACHE_TTL_MS = 30_000`; cache path constant `CACHE_FILENAME = 'overview-cache.json'` under `getDubDir(cwd)`.
- [x] `--refresh` flag (consumed by callers) busts the cache - `options.refresh` short-circuits the cache read; tested in 'refetches when refresh: true even if the cache is fresh'.
- [x] Truncation flag surfaced to callers - `StackOverview.truncated` mirrors `prBatch.truncated`; tested in 'surfaces truncated:true from getStackOverviewPrBatch'.
- [x] No regression for `getAllPrSyncInfoBatch` callers (sync still works) - `getAllPrSyncInfoBatch` and its 5 tests are untouched; `getStackOverviewPrBatch` is added alongside.
- [x] Tests: fresh fetch, cache hit, cache stale, refresh override, truncation flag - All 5 named scenarios covered in stack-overview.test.ts (plus future-date and write-failure).

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Critical: cache write error propagated to caller. Resolved by wrapping `writeCache` in try/catch (stack-overview.ts:135-138) and adding the `cache write failure` test.

## Dependencies

- **DUB-7 (batched gh pr list):** Merged — provides `getAllPrSyncInfoBatch` and `BATCH_PR_LIST_LIMIT`.
- **DUB-37 (freeze/unfreeze):** Backlog — `frozen` field join deferred per issue description; not blocking.

## Rollout

Pure library addition — no command wired to it yet. Zero user-visible behavior change. The follow-up issue (DUB-26) lights it up in `dub log`.

- **On merge - Land library:** Squash-merge to main; no migration, no flag, no config change.
- **After merge - Wire renderers (DUB-26):** Update `dub log`, `dub co`, `dub status`, `dub watch` to call `getStackOverviewBatch` instead of per-branch helpers.
- **Future - Add `frozen` join (after DUB-37):** Once `Branch.frozen` exists in state, include it in the `BranchOverview` shape.

## Commit

```text
feat(stack-overview): batched PR/CI data layer with 30s on-disk cache [DUB-25]
```
