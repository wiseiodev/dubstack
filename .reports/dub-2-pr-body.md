## TL;DR

Adds `retry<T>(fn, options)` in `packages/cli/src/lib/retry.ts` with exponential backoff (`min(baseMs*2^n, maxMs)`), small jitter, `isPermanent` short-circuit, and an `onRetry` hook. Ten unit tests cover the success path, transient retries, permanent short-circuit, exhaustion, backoff/jitter math, and input validation.

## Why

Provides the retry primitive used by upcoming slices that wrap git and gh calls so transient failures don't break stack operations.

Lands as a pure utility so reviewers can scrutinize the backoff math and contract before consumers depend on it.

### Before

- No shared retry helper — any retry logic would have to be reinvented at each call site.
- Transient git/gh failures (rate limits, flaky networks) surface immediately as user-facing errors.

### After

- `retry()` is available as the single source of truth for retry behavior in `src/lib/`.
- Consumers can hook into `onRetry` for verbose progress reporting and `isPermanent` to skip retrying known-permanent errors.

## File-by-file

### packages/cli/src/lib/retry.ts

new +91 / -0

Exports `retry<T>(fn, options)`. Defaults: 4 attempts, baseMs 100, maxMs 2000. Computes `min(baseMs * 2^(attempt-1), maxMs)` plus up to 25% jitter, capped at maxMs. `isPermanent(err)` short-circuits by rethrowing the original error. `onRetry(attempt, err)` fires before each retry (attempt > 1). After exhaustion throws `new Error(..., { cause: lastError })` with the attempt count in the message. `sleep` and `random` are injectable for deterministic tests.

```ts
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // ...
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isPermanent?.(err)) throw err;
      if (attempt >= maxAttempts) break;
      const exp = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      const jitter = exp * 0.25 * random();
      const delay = Math.min(exp + jitter, maxMs);
      onRetry?.(attempt + 1, err);
      await sleep(delay);
    }
  }
  // throw wrapped Error with cause
}
```

### packages/cli/src/lib/retry.test.ts

new +167 / -0

Ten vitest cases. Uses injected `sleep`/`random` to make timing deterministic. Verifies: first-attempt success, transient-then-success, no `onRetry` on attempt 1, `isPermanent` short-circuit (preserving the original error identity), exhaustion throws with `giving up after N attempts` and preserves `cause`, exponential backoff capped at maxMs, jitter math at `random=0.5`, `maxAttempts=0` rejected before calling fn, and `maxAttempts=1` runs fn exactly once.

## Where to focus review

1. **Backoff math + jitter cap** - `packages/cli/src/lib/retry.ts:73-79`: The exponent uses `attempt - 1` so the first retry waits `baseMs`, not `baseMs*2`. Jitter is added on top and the final delay is re-capped at `maxMs` so the jitter can never push past the ceiling. Tests at retry.test.ts:103 and :125 lock both behaviors.
2. **Error-cause preservation on exhaustion** - `packages/cli/src/lib/retry.ts:84-89`: Uses the standard `new Error(msg, { cause })` form so consumers can introspect the underlying failure. retry.test.ts:79 asserts `.cause` identity.
3. **isPermanent short-circuit semantics** - `packages/cli/src/lib/retry.ts:67-70`: Rethrows the original error (not a wrapped one) and does not call `onRetry` — confirm this matches the contract expected by consumers.

## Test plan

- [x] **unit:** retry.test.ts (10 cases) — success, retry-to-success, permanent short-circuit, exhaustion + cause, backoff cap, jitter math, validation, single-attempt path - pnpm test -- retry → 10 passed
- [x] **build:** tsup build of packages/cli - Triggered by `pnpm test` turbo pipeline — ESM build succeeded.

## Quality gates

- **lint+format (biome):** `pnpm checks` - passed (Checked 190 files. No fixes applied.)
- **typecheck (tsc):** `pnpm typecheck` - passed (2 packages typechecked, no errors.)
- **unit tests (vitest):** `pnpm test` - passed (69 test files, 518 tests passed (10 new in retry.test.ts).)

## Self-QA

See [QA fallback evidence](.reports/dub-2-qa.md).

Self-QA captured deterministically via the new unit suite and the three quality gates.

- Transient failure recovers and returns the value.
- Permanent error short-circuits without further retries.
- All attempts fail → wrapped Error with `cause` and attempt count.
- Backoff respects `maxMs` and adds jitter without exceeding it.

## Acceptance criteria

- [x] `packages/cli/src/lib/retry.ts` exports `retry<T>(fn, options)` - retry.ts:48 exports the function.
- [x] Default 4 attempts, 100–2000ms backoff with jitter - Constants at retry.ts:33-35; jitter test at retry.test.ts:125.
- [x] `isPermanent` predicate skips retry - retry.ts:67-70; test at retry.test.ts:47.
- [x] `onRetry` callback fires before each attempt > 1 - retry.ts:78; tests at retry.test.ts:18 and :38.
- [x] Throws last error after exhaustion with attempt count in message - retry.ts:85-88; test at retry.test.ts:67.
- [x] Unit tests: transient succeeds, permanent short-circuits, all-fail throws - retry.test.ts:18, :47, :67.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Reviewer flagged manual `.cause` assignment — switched to `new Error(msg, { cause })`.
- Reviewer flagged missing test for `maxAttempts < 1` guard — added `rejects an invalid maxAttempts before calling fn`.

## Dependencies

- **No external dependencies detected:** n/a

## Rollout

Pure addition. No behavior change for existing CLI commands; consumers land in later slices.

- **On merge - Ship as-is:** No flags, no migrations, no consumers. Future slices will import `retry` from `./lib/retry`.

## Commit

```text
feat(cli): add retry helper with exponential backoff
```
