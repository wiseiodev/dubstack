# Self-QA fallback - DUB-12

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

This is a terminal CLI change. The progress bars are rendered via
`cli-progress` to `process.stderr` and are TTY-aware (no-op in CI / non-TTY).
A screen recording would only show terminal output; the deterministic proof
below verifies the semantics that matter — pause/resume around prints,
no-op in CI, stop on error, sanitized verbose subprocess logs — without
relying on a frame-accurate video diff.

No `.tsx` files were touched.

## What was verified

### 1. Two-pass adversarial review (independent agent)

**Pass 1 findings (both critical, both fixed):**

- *Orphaned progress bars on error paths in `sync.ts`.* Any exception thrown
  inside the fetch / cleanup / reconcile loops would land in the existing
  `catch` block without stopping the active bar, leaving the terminal cursor
  hidden (`cli-progress` sets `hideCursor: true`). **Fix:** added a
  `Progress.stop()` method that calls `bar.stop()` without forcing the
  value to 100%, then wrapped each command body (`sync.ts`, `submit.ts`,
  `restack.ts`'s `executeRestackSteps`) in `try { ... } finally {
  progress.stop(); }`.
- *Raw `console.log` calls during the active cleanup bar in `sync.ts`.* The
  auto-clean lines at L297-L302 printed while the `'🧹 Cleaning merged'`
  bar was rendering, corrupting terminal output. **Fix:** wrapped those
  lines in `progress.pause()` / `progress.resume()`.

**Pass 2 finding (major, fixed):**

- *`choose()` / `confirm()` writes collide with the reconcile bar.* Inside
  the reconcile loop the `'🔄 Reconciling'` bar is active when an interactive
  prompt fires (`needs-remote-sync`, `unsubmitted`, `reconcile-needed`
  diverge paths). Neither helper paused the bar. **Fix:** both helpers now
  call `getActiveProgress()?.pause()` at the top and `?.resume()` in their
  `finally` block — mirrors how `printBranchOutcome` handles it. Works for
  the trunk-sync loop too where no bar is active (pause/resume become no-ops
  on null).

### 2. Unit suite — 609 tests, all green

- New tests: `lib/sync/report.test.ts` (3 tests) verifies `printBranchOutcome`
  is a console pass-through when no progress is active, pauses+resumes the
  bar in TTY mode (writes increase across the pause/resume cycle), and is a
  silent no-op for progress writes in non-TTY mode.
- New tests: `lib/exec.test.ts` (2 tests) verify the `execa` wrapper runs
  the subprocess unchanged when verbose is off and prints the sanitized
  command line (basic-auth redacted) when verbose is on.
- Extended: `lib/progress.test.ts` now covers `stop()` — bar halts without
  the 100% nudge, `activeProgress` is cleared, second `stop()` is a no-op.

### 3. Repo-discovered gates

| Gate | Command | Result |
| --- | --- | --- |
| lint + format | `pnpm checks` | Checked 218 files, no fixes |
| typecheck | `pnpm typecheck` | turbo cached + dubstack pass |
| unit tests | `pnpm test` | 76 files, 609 tests passed in 6.4s |
| build | `pnpm build` | tsup ESM build success |
| evals | `pnpm evals` | n/a — AI metadata/prompts unchanged; pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch blocks local runs, same status as DUB-3 |

### 4. End-to-end smoke

- `node packages/cli/dist/index.js --help` shows `--verbose` at the root
  with the documented description.
- `node packages/cli/dist/index.js --verbose log` outside an initialized
  dub repo prints each `git rev-parse ...` call before running, confirming
  the new `exec.ts` wrapper routes every subprocess through
  `logVerboseCommand` and that the wrapper is path-correct for `git.ts`,
  `github.ts`, and `git/is-merged-by-patch-id.ts`.

## Evidence

- Commit SHA: see `dub-12-report-data.json`.
- Files touched: 13 (4 commands, 4 lib files, 4 tests, +1 new `exec.ts`).
- Behavior contract: every command that creates progress now wraps its body
  in `try { ... } finally { progress.stop(); }` so an exception cannot
  orphan a hidden cursor. Every helper that prints during a bar (the cleanup
  loop, the interactive prompts, `printBranchOutcome`) is paired with
  pause/resume.

## Follow-up flag

None. Acceptance criteria below are all satisfied. No deferred work.
