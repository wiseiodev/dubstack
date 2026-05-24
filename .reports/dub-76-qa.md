# Self-QA fallback - DUB-76

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-76 is purely CLI-internal: it restructures `lib/sync/journal.ts` and
`lib/sync/cleanup-resume.ts` into a shared `lib/cleanup-{journal,resume}.ts`
pair, adds a new `CleanupRetargetOp`, and threads journal calls through
`post-merge` and `merge-next`. There is no user-visible UI surface to record.

## What was verified

- `pnpm checks` → biome lint + format passes on 246 files.
- `pnpm typecheck` → tsc --noEmit passes for both `dubstack` and `docs`.
- `pnpm test` → 84 test files, 699 tests pass.
- Targeted suites (`post-merge.test.ts`, `merge-next.test.ts`,
  `test/lib/cleanup-resume.test.ts`, `test/lib/cleanup-journal.test.ts`) all
  pass with the new journaling assertions.
- Crash-safety contract verified:
  - Post-merge writeState failure leaves journal on disk (`'leaves the journal
    in place when writeState fails so dub continue can resume'`).
  - Merge-next retargetPrBase failure leaves journal on disk (`'leaves the
    retarget journal in place when retargetPrBase throws'`).
  - `resumeCleanup` retarget op is idempotent: skip when PR base already
    matches, skip when PR is not OPEN, retarget only when needed.

## Evidence

- `pnpm checks` output: `Checked 246 files in 50ms. No fixes applied.`
- `pnpm typecheck` output: `Tasks: 2 successful, 2 total`
- `pnpm test` output: `Test Files 84 passed (84) | Tests 699 passed (699)`
- New tests covering the acceptance criteria:
  - `packages/cli/src/commands/post-merge.test.ts` — journals reparent+delete
    ops in order, retarget op alongside, no journal in dry-run, journal
    retained on writeState failure.
  - `packages/cli/src/commands/merge-next.test.ts` — journals retarget ops
    before each `retargetPrBase` call, skips journal when no children, retains
    journal on failure.
  - `packages/cli/test/lib/cleanup-resume.test.ts` — replays retarget op only
    when current base differs, skips when already-applied, skips when PR is
    not OPEN.

## Follow-up flag

None. Adversarial review found one critical finding (post-merge's
`retargetOpenPrBranches` was outside the journal); addressed in this PR by
threading the journal through `retargetOpenPrBranches`. Sync's existing
unjournaled retarget at `sync.ts:1000` is unchanged (out of scope; pre-DUB-76
behavior).
