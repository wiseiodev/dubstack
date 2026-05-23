# Self-QA fallback - DUB-10

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

Pure CLI library change in `packages/cli/src/lib/github.ts`. No `.tsx` files,
no UI surface, no browser-demoable behavior. The retry + idempotency behavior
is exercised end-to-end by Vitest unit tests mocking `execa`.

## What was verified

- Every `gh` API call in `lib/github.ts` (`getPr`, `getPrByNumber`,
  `getBranchPrSyncInfo`, `getBranchPrLifecycleState`, `getAllPrSyncInfoBatch`,
  `getPrStateByNumber`, `getPrMergeStatusByNumber`, `updatePrBody`,
  `retargetPrBase`, `mergePr`, plus the `ensureGhInstalled` /
  `checkGhAuth` probes) now flows through the shared `runGh` retry wrapper.
- Permanent errors short-circuit: HTTP `401`/`403`/`404`, "could not resolve
  to a pull request" (and `pullrequest` GraphQL variant), "no pull requests
  found", and bare "not found" all classified by `isPermanentGhError` —
  retry rethrows immediately, so existing `isPrNotFoundError` callers still
  see the original error and convert to `null` as before.
- Transient errors (e.g. `502 Bad Gateway`, network timeout) retry up to
  4 attempts with exponential backoff via the DUB-2 `retry` helper.
- `createPr` keeps its own retry loop with an idempotency guard: before
  every retry attempt, it calls `getPr(branch)`; if a PR with the intended
  `title` already exists, it returns that PR instead of retrying. This
  prevents phantom duplicates when the first attempt succeeded server-side
  but the response was lost to a transient network error.
- Successful first-attempt behavior is unchanged — no extra `getPr` call is
  issued unless an attempt has already failed.
- `unwrapRetryError` recursively peels `retry: giving up after N attempts`
  wrappers so DubError messages and `isPrNotFoundError` checks operate on
  the underlying cause, including the nested-retry chain produced when
  `createPr`'s idempotency check itself fails transiently.
- A test-only seam, `__setGhRetryOptionsForTesting`, lets the github tests
  disable backoff sleeps and jitter so retry behavior can be asserted
  without wall-clock waits.

## Evidence

- `pnpm checks` — clean (Biome lint + format across 199 files).
- `pnpm typecheck` — passes for both `dubstack` and `docs` packages.
- `pnpm test` — 560 tests passing across 71 files. New cases in
  `packages/cli/src/lib/github.test.ts`:
  - `gh retry behavior` — 5 cases:
    1. `getPr` retries on transient 502→timeout→success (3 execa calls).
    2. `getPrByNumber` short-circuits on permanent 404 (1 execa call).
    3. `updatePrBody` short-circuits on permanent 403 (1 execa call).
    4. `getBranchPrSyncInfo` exhausts retries on persistent 502 with a
       `retry: giving up after 4 attempts` wrapper.
    5. `mergePr` retries on transient 502→success (2 execa calls).
  - `createPr idempotency guard` — 5 cases:
    1. Phantom duplicate detected on retry: returns existing PR; 2 execa
       calls (the failed create + the idempotency `gh pr list`).
    2. Retries createPr when no PR exists yet.
    3. Retries createPr when an unrelated PR title is present.
    4. Does not retry createPr on permanent 403.
    5. Wraps the underlying error after exhausting retries (message
       includes the original `502` and the `Failed to create PR for
       '<branch>'` prefix).

## Follow-up flag

None. Live wall-clock retry latency in production paths (`dub submit`,
`dub merge-next`, `dub sync`) inherits the DUB-2 defaults
(`maxAttempts: 4`, `baseMs: 100`, `maxMs: 2000`). If those defaults turn
out to be too patient for interactive UX, the place to tune is
`packages/cli/src/lib/retry.ts`, not this layer.
