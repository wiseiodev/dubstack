# Self-QA fallback - DUB-25

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-25 ships a pure data-layer library (`lib/stack-overview.ts` + two batch
helpers in `lib/git.ts` and `lib/github.ts`). No `.tsx` files changed, no CLI
command is wired up to it yet (callers in `dub log` / `dub co` / `dub status`
land in DUB-26 and later). There is no rendered output to film.

## What was verified

Acceptance criteria checked via automated tests:

| Criterion | Test |
| --- | --- |
| `getStackOverviewBatch` exported from `lib/stack-overview.ts` | `stack-overview.test.ts > issues one gh call + one for-each-ref and joins state` |
| One `gh pr list` + one `git for-each-ref` for the whole stack | same test asserts call counts == 1 each |
| 30-second on-disk TTL cache at `.git/dubstack/overview-cache.json` | `writes the cache to .git/dubstack/overview-cache.json` |
| `--refresh` flag (consumed by callers) busts the cache | `refetches when refresh: true even if the cache is fresh` |
| Truncation flag surfaced to callers | `surfaces truncated:true from getStackOverviewPrBatch` |
| No regression for `getAllPrSyncInfoBatch` callers (sync still works) | `getAllPrSyncInfoBatch` block (5 tests) unchanged + new function `getStackOverviewPrBatch` added alongside |
| Tests: fresh fetch | `issues one gh call + one for-each-ref and joins state` |
| Tests: cache hit | `returns the cached overview on a hit without calling gh/git` |
| Tests: cache stale | `refetches when the cache is stale` |
| Tests: refresh override | `refetches when refresh: true even if the cache is fresh` |
| Tests: truncation flag | `surfaces truncated:true from getStackOverviewPrBatch` |
| Cache write resilience (added per adversarial review) | `returns the overview even when the cache write fails` |

Gates run from repo root:

- `pnpm checks` — passed (biome, 263 files)
- `pnpm typecheck` — passed (tsc --noEmit)
- `pnpm test` — passed (87 files, 806 tests)

## Evidence

- `.reports/dub-25-report-data.json` — file tour and stats
- `packages/cli/src/lib/stack-overview.test.ts` — 9 tests for the orchestrator
- `packages/cli/src/lib/git.test.ts` — 3 new tests for `getBranchCommitMetaBatch`
- `packages/cli/src/lib/github.test.ts` — 6 new tests for `getStackOverviewPrBatch`

## Follow-up flag

None blocking. DUB-26 wires the data layer into `dub log`; the `frozen` field
join is deferred until DUB-37 lands (per issue description).
