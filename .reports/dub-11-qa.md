# Self-QA fallback - dub-11

> This work item has no browser/UI surface, so this file replaces the video
> and records deterministic proof instead.

## Why no video

DUB-11 is a pure CLI library change: wrap `fetchBranches` and `pushBranch`
in `packages/cli/src/lib/git.ts` with the existing `retry` helper, classify
permanent vs transient git errors, and surface lease rejections as
`DubError` with a `dub sync` recovery hint. No TSX, no UI, no command-level
flag changes. All evidence below is reproducible from the staged diff.

## What was verified

1. **`fetchBranches` retries up to 4 times** on transient errors —
   `packages/cli/src/lib/git.retry.test.ts` "retries up to 4 attempts on
   persistent transient failure" asserts `mockExeca` is called exactly 4
   times before throwing.
2. **`pushBranch` retries up to 4 times** — same retry helper (default
   `maxAttempts: 4`) is shared; transient-then-success test verifies
   exactly 2 calls.
3. **Auth + "not found" short-circuit** — `isFetchPermanentError` and
   `isPushPermanentError` (`packages/cli/src/lib/git.ts`) match
   `fatal: Authentication failed` and `Repository not found` and pass
   them to `retry`'s `isPermanent` predicate. Tests assert 1 call only.
4. **`--force-with-lease` rejection → DubError with `dub sync` hint** —
   matches `(stale info)` in stderr, throws
   `DubError("…force-with-lease rejected…", ["Run 'dub sync' to refresh
   remote tracking, then retry the push.", …])`. Verified by the
   `surfaces lease rejection as a DubError with dub-sync recovery hint`
   test.
5. **Per-call `onRetry`** — both functions accept an `options.onRetry`
   that is forwarded into `retry`'s `onRetry`. Callers under `--verbose`
   can wire a `console.error` line to it. Test asserts
   `onRetry(2, Error)` fires exactly once on the transient → success
   path.
6. **Acceptance test pair** — "transient fetch failure → success after
   one retry" and "auth failure → immediate throw" both in
   `git.retry.test.ts`.
7. **Backward-compatible signatures** — `pushBranch(branch, cwd)` and
   `fetchBranches(branches, cwd[, remote])` still compile (options is an
   appended optional argument, no breaking change for existing call
   sites in `submit.ts`, `sync.ts`, `doctor.ts`, `post-merge.ts`,
   `prune.ts`).
8. **`couldn't find remote ref` still skipped** — classified as
   permanent inside `isFetchPermanentError`, then matched in the catch
   block to `continue` to the next branch. Test asserts no retries and
   no throw.

## Evidence

### §1 Gates

```
pnpm checks   → biome check, 200 files, 0 errors
pnpm typecheck → turbo, dubstack + docs both pass tsc --noEmit
pnpm test     → 72 test files, 560 tests passing (was 550 before
                git.retry.test.ts added its 10 cases)
```

### §2 Targeted retry tests

```
$ cd packages/cli && pnpm exec vitest run src/lib/git.retry.test.ts
 ✓ src/lib/git.retry.test.ts (10 tests) 1000ms
   ✓ retries up to 4 attempts on persistent transient failure 784ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### §3 Adversarial review

Self-review of the staged diff before commit, focused on the retry
classifier:

- Confirmed `retry` short-circuit path throws the *original* git error
  (not a wrapped one), so `readGitErrorOutput` reads `.stderr` directly
  on the permanent-error code path. Exhaustion path wraps with
  `{ cause }` — handled by the `.cause` fallback.
- Confirmed lease rejection is always classified permanent on attempt
  1, so the stale-info detection in the catch block never has to walk
  through `cause`.
- Confirmed all five existing call sites
  (`submit.ts:154`, `sync.ts:170`, `prune.ts:47`, `post-merge.ts:113`,
  `doctor.ts:106,232`) keep compiling because the new `options` arg is
  optional and trailing.
- Pattern `/stale info/i` matches the canonical `--force-with-lease`
  rejection line `! [rejected] branch -> branch (stale info)`. Regular
  non-FF rejections print `(non-fast-forward)` instead and would fall
  through to retry.

## Follow-up flag

None for this PR. Future work (a separate issue) could wire the
`onRetry` callbacks in `sync.ts`/`submit.ts` to emit verbose log lines
under a top-level `--verbose` flag once the CLI gains one.
