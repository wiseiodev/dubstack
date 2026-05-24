# Self-QA fallback - DUB-29

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub watch` is a CLI-only long-lived process that prints to stdout, watches `.git/*` paths, and posts OS desktop notifications. There is no browser UI; recording the process would just show a terminal cursor. No `.tsx` files changed in this diff.

## What was verified

1. **Three required gates pass against the staged diff:**
   - `pnpm checks` (biome) — clean (283 files, 0 errors).
   - `pnpm typecheck` (tsc --noEmit) — clean.
   - `pnpm test` (vitest) — 861/861 passing, including 17 new tests in `src/lib/watch.test.ts`, 4 in `src/commands/watch.test.ts`, 8 in `src/lib/duration.test.ts`, and 4 in `src/lib/notify.test.ts`.
2. **Adversarial review** (feature-dev:code-reviewer) found 1 critical + 1 major + 1 important; all addressed before commit. See `adversarialReview` in `dub-29-report-data.json` for the trail.
3. **Acceptance criteria** verified — see `acceptanceCriteria` table in the report. Every criterion is backed by either a passing test or a concrete code reference.

## Evidence

- `packages/cli/src/lib/watch.test.ts` — orchestration tests covering poll interval scheduling, `.git` file-watcher dispatch, cleanup-journal pause/resume, offline auto-pause, HTTP 429 backoff, graceful stop(), and the concurrent-trigger coalescing race added during review.
- `packages/cli/src/lib/notify.test.ts` — platform routing (osascript / notify-send / powershell), shell-quote escaping, and failure tolerance.
- `packages/cli/src/lib/duration.test.ts` — duration parser unit tests (`30s`, `2m`, `1h`, decimals, malformed).
- `packages/cli/src/commands/watch.test.ts` — CLI option validation (interval floor + parse error).
- `.reports/dub-29-report-data.json` — full structured report.

## Follow-up flag

None — work is self-contained behind the new `dub watch` command and does not modify any existing flow. ETag/If-None-Match support is deferred (issue mentioned it as a stretch goal "likely requires dropping to gh api directly"); the on-disk overview cache from DUB-25 already absorbs most of the rate-limit pressure.
