# Self-QA fallback - DUB-2

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

The change adds a pure async utility (`packages/cli/src/lib/retry.ts`) with no
CLI surface, no UI, and no consumers yet — the issue explicitly defers
integration to later slices. There is nothing to demonstrate in a browser or
terminal recording.

## What was verified

- `pnpm test` — full suite passes (518 tests, including 10 new retry tests).
- `pnpm typecheck` — passes.
- `pnpm checks` — biome lint/format passes.
- Acceptance criteria walked through the test cases:
  - transient-then-success path: covered by `retries a transient failure and eventually succeeds`.
  - permanent short-circuit: covered by `short-circuits when isPermanent returns true`.
  - exhaustion path: covered by `throws a wrapped error with attempt count after exhaustion`.
  - defaults (4 attempts, 100–2000ms, jitter): covered by the backoff+jitter delay tests.
  - `onRetry` fires only on attempts > 1: covered by `does not fire onRetry on the first attempt`.

## Evidence

- New unit tests: `packages/cli/src/lib/retry.test.ts` (10 cases).
- Implementation: `packages/cli/src/lib/retry.ts`.
- Quality gates output captured in the HTML report.

## Follow-up flag

None. Consumers (git/gh wrappers) land in subsequent slices per the parent
project plan.
