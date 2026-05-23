## TL;DR

`gh` API calls now retry transient failures via the DUB-2 helper with permanent-error short-circuiting. `createPr` checks for a phantom-duplicate PR (matching title) before each retry attempt.

## Why

Transient GitHub 5xx and network blips were surfacing as hard failures from `dub submit`, `dub merge-next`, and `dub sync`.

A successful `createPr` whose response was lost to a 502 would silently re-create the PR on the next attempt, leaving duplicate PRs against the same branch.

### Before

- Each `gh` call in `lib/github.ts` issued a single `execa('gh', ...)` and rethrew on the first failure.
- `createPr` had no idempotency guard; any retry path (manual or otherwise) risked phantom duplicates.

### After

- A new internal `runGh` helper drives every `gh` call through the DUB-2 `retry` helper with an `isPermanentGhError` classifier (HTTP 401/403/404, GraphQL PR-not-found variants, `ENOENT`).
- `createPr` keeps its own retry loop and calls `getPr(branch)` before each retry attempt — if a PR with the intended title already exists, it returns that PR instead of issuing another `gh pr create`.
- `unwrapRetryError` recursively peels `retry: giving up after N attempts` wrappers so `DubError` messages and the `isPrNotFoundError` classifier still see the underlying cause.

## File-by-file

### packages/cli/src/lib/github.ts

mod +244 / -70

Introduces `runGh` (private), `isPermanentGhError`, `unwrapRetryError`, and the `__setGhRetryOptionsForTesting` test seam. Refactors every gh call site — including `ensureGhInstalled`, `checkGhAuth`, `getPr`, `getPrByNumber`, `getBranchPrSyncInfo`, `getAllPrSyncInfoBatch`, `getPrStateByNumber`, `getPrMergeStatusByNumber`, `updatePrBody`, `retargetPrBase`, `mergePr`, and `openPrInBrowser` — to flow through `runGh`. `createPr` keeps its own retry loop so it can interleave the idempotency `getPr(branch)` check between attempts.

```ts
async function runGh(
  args: string[],
  options: Options = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await retry(() => execa('gh', args, options), {
    isPermanent: isPermanentGhError,
    ...ghRetryOverrides,
  });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}
```

### packages/cli/src/lib/github.test.ts

mod +181 / -0

Adds 10 new test cases covering the retry wrapper (transient → success, permanent short-circuit, exhaustion wrapping) and the createPr idempotency guard (phantom duplicate returns existing PR, unrelated title triggers retry, permanent 403 short-circuits). Adds `__setGhRetryOptionsForTesting` setup in `beforeEach` so retries run without wall-clock backoff.

```ts
it('returns the existing PR when a phantom duplicate is detected on retry', async () => {
  mockExeca
    .mockRejectedValueOnce(new Error('502 Bad Gateway'))
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 77,
        url: phantomUrl,
        title: 'feat: x',
        body: '',
      }),
    });

  const result = await createPr('feat/x', 'main', 'feat: x', '/tmp/body.md', '/repo');
  expect(result.number).toBe(77);
  expect(mockExeca).toHaveBeenCalledTimes(2);
});
```

### .reports/dub-10-qa.md

new +70 / -0

Self-QA fallback. No `.tsx` files changed and the work is pure CLI library logic, so a Playwright video has no useful surface. The report enumerates the wrapped call sites, the permanent-error classifier coverage, the createPr idempotency contract, and the quality-gate evidence.

### .reports/dub-10-{pr-body.md,report-data.json,.html}

new +969 / -0

Generated artifacts from the do-issue report renderer. `dub-10-report-data.json` is the schema-validated source of truth; `dub-10.html` is the rendered review page; `dub-10-pr-body.md` is what populated the PR description. They follow the same convention as prior issues' reports under .reports/.

## Where to focus review

1. **Permanent-error classifier scope** - `packages/cli/src/lib/github.ts:isPermanentGhError`: The classifier governs whether a `gh` failure short-circuits or retries. It intentionally drops the bare `not found` substring (kept in `isPrNotFoundError`) to avoid false positives from OS/DNS messages like `host not found`. Worth a second pair of eyes on the regex/string set.
2. **createPr idempotency loop semantics** - `packages/cli/src/lib/github.ts:createPr`: Uses a manual `retry(...)` rather than `runGh` because the idempotency `getPr` check needs to run between attempts. `ghRetryOverrides` are forwarded so the test seam still applies. The nested `getPr` itself goes through `runGh` and can compound under sustained network failure — documented in the JSDoc.
3. **unwrapRetryError recursion** - `packages/cli/src/lib/github.ts:unwrapRetryError`: Recursively peels `retry: giving up after N attempts` wrappers so downstream classifiers and DubError messages see the underlying cause. Termination relies on the wrapper's message prefix; non-wrapper errors return as-is.

## Test plan

- [x] **unit:** gh retry behavior (5 cases) and createPr idempotency guard (5 cases) - packages/cli/src/lib/github.test.ts — 10 new specs covering transient→success retry, permanent short-circuit on 404/403, retry exhaustion wrapper, mergePr transient retry, phantom-duplicate return, retry-when-no-PR, retry-when-unrelated-PR, no-retry on 403, and wrapped error after exhaustion.
- [x] **unit:** Full vitest suite - `pnpm test` → 71 files / 560 tests passing (no regressions in command/lib/test fixtures that depend on github.ts).

## Quality gates

- **Lint + format:** `pnpm checks` - passed (Biome clean across 199 files.)
- **Typecheck:** `pnpm typecheck` - passed (tsc --noEmit clean for `dubstack` and `docs`.)
- **Tests:** `pnpm test` - passed (560 tests passing across 71 files.)

## Self-QA

See [QA fallback evidence](.reports/dub-10-qa.md).

Deterministic proof via Vitest unit tests; see fallback QA file for the wrapped-callsite enumeration and quality-gate evidence.

- Transient 502 → retry → success (getPr, mergePr).
- Permanent 403/404 → short-circuit (updatePrBody, getPrByNumber, createPr).
- Retry exhaustion → wrapped error preserves the underlying cause via unwrapRetryError.
- createPr phantom duplicate → returns the existing PR without a second create call.
- createPr no-existing-PR → retries the create.

## Acceptance criteria

- [x] Every `execa('gh', ...)` call in `lib/github.ts` wrapped via the retry helper. - All gh call sites (probes, list/view/create/edit/merge, browser open) now flow through `runGh`. `createPr` uses a manual `retry(...)` with the same `ghRetryOverrides` forwarded; that bypass is documented in the function's JSDoc.
- [x] Permanent errors short-circuit (no retry on 404, 403, etc.). - `isPermanentGhError` covers HTTP 401/403/404, GraphQL PR-not-found variants, `no pull requests found`, and `ENOENT`. Verified by `short-circuits getPrByNumber on permanent 404`, `short-circuits updatePrBody on permanent 403`, and `does not retry createPr on permanent 403` test cases.
- [x] Transient errors (502, network timeout) retry up to 4 times with backoff. - Inherits defaults from `lib/retry.ts` (`maxAttempts: 4`, `baseMs: 100`, `maxMs: 2000`). Verified by `retries getPr on transient failure and succeeds` (3 calls) and `retries up to maxAttempts then wraps the failure` (4 calls).
- [x] `createPr` performs a `getPr` check before retrying to avoid phantom duplicates. - `createPr` retry callback calls `getPr(branch, cwd)` when `attempt > 1`. If the returned PR's title matches the intended title, it is returned without another `gh pr create`. Verified by `returns the existing PR when a phantom duplicate is detected on retry`.
- [x] Tests cover transient → success, permanent → throw, and phantom-duplicate scenarios. - 10 new specs in `packages/cli/src/lib/github.test.ts`.
- [x] No behavior change for successful first attempts. - Successful first attempts skip the idempotency check (`attempt > 1` guard) and exit `retry` after one call. Existing single-attempt tests (`getPr returns PrInfo`, `createPr parses PR number from stdout URL`, etc.) pass unchanged.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 2/0

- Resolved (critical): `openPrInBrowser` was unwrapped — now flows through `runGh` with `unwrapRetryError` in the catch block.
- Resolved (critical): documented the intentional `execa` bypass inside `createPr`'s retry loop, with the rationale that `ghRetryOverrides` are explicitly forwarded so the test seam still applies.
- Resolved (important): tightened `isPermanentGhError` — dropped the bare `not found` substring (kept in `isPrNotFoundError`) and added `ENOENT` so transient OS/DNS errors that happen to include `not found` are still retried.
- Acknowledged (minor): nested `getPr` retry inside `createPr` can compound to up to `maxAttempts × (1 + maxAttempts)` gh calls under sustained network failure. Documented in the `createPr` JSDoc; bounded by `maxMs`.

## Dependencies

- **DUB-2 retry helper (lib/retry.ts):** satisfied — merged in 5f14fb9

## Rollout

Library-only change shipped as a normal merge. No flags, no migrations.

- **On merge - Ship:** `feat(cli)` PR lands on `main`; subsequent `dub` releases pick up the retry coverage automatically.
- **Post-merge - Observe:** Watch for any new `retry: giving up after 4 attempts` messages in user reports — they indicate sustained GitHub degradation, not a regression in this change.

## Commit

```text
feat(cli): retry+idempotency for gh calls in lib/github.ts (DUB-10)
```
