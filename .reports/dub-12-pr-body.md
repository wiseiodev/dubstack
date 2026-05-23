## TL;DR

sync, submit, and restack each create one Progress instance, start/update/complete per phase, and wrap their body in try { ... } finally { progress.stop() } so an exception cannot leave the terminal cursor hidden. printBranchOutcome and the sync confirm()/choose() helpers pause+resume the active bar through getActiveProgress(). git/gh subprocesses now route through lib/exec.ts, a thin execa wrapper that calls logVerboseCommand before each invocation (sanitized via sanitizeRemoteUrl). Adds Progress.stop() (halts the bar without forcing 100%) plus 5 new tests for the new wrapper, the sync/report pause/resume contract, and verbose subprocess logging.

## Why

Tier 0 sync magic needs visible progress for the slow git/gh phases or users assume the CLI is hung.

Per-branch outcomes still need to land as readable summary lines, so the bar has to coexist with console writes instead of replacing them.

Operators must be able to tail git/gh subprocess invocations under --verbose without leaking secrets — the foundation is DUB-3's logVerboseCommand + sanitizeRemoteUrl.

### Before

- sync / submit / restack only printed phase headers and per-branch outcome lines; long fetches looked frozen.
- No way to trace which git or gh call a command was on without re-running under DEBUG.
- Interactive prompts and per-branch logs would have torn the bar if a bar had existed.

### After

- Each command instantiates Progress once and drives one bar per phase; CI/non-TTY callers get a no-op that preserves the existing summary-only output.
- Errors call progress.stop() in a finally, so a thrown exception cannot leave hideCursor stuck on.
- --verbose prints `$ git ...` / `$ gh ...` for every subprocess, sanitized of basic-auth and token query params, and pauses+resumes the bar around each printed line.

## File-by-file

### packages/cli/src/lib/exec.ts

new +28 / -0

Thin wrapper around execa preserving its overloaded call signatures. Before invoking the subprocess it calls logVerboseCommand(file, args, { progress: getActiveProgress() }) so --verbose prints the sanitized command and pauses any active bar around the print. When verbose is off the wrapper is functionally equivalent to execa itself.

```typescript
export const execa: RawExeca = ((file: string, args?: readonly string[], options?: unknown) => {
  logVerboseCommand(file, args ?? [], { progress: getActiveProgress() });
  return (rawExeca as unknown as (...a: unknown[]) => unknown)(file, args, options);
}) as unknown as RawExeca;
```

### packages/cli/src/lib/git.ts

mod +10 / -1

Re-routes the execa import to ./exec so all 50+ git subprocess calls flow through the verbose wrapper. Adds an onBranchStart callback to FetchBranchesOptions and fires it before each per-branch fetch so the sync caller can update the progress bar with the current branch name as detail.

```typescript
options.onBranchStart?.(index, branch);
const refspec = `${branch}:${namespacedFetchRef(branch)}`;
```

### packages/cli/src/lib/github.ts

mod +1 / -1

Re-routes the execa import to ./exec. The central runGh() wrapper means every gh call (gh pr list, gh pr view, gh pr create, gh pr edit, etc.) now logs under --verbose without further changes.

```typescript
import { execa, type Options } from './exec';
```

### packages/cli/src/lib/git/is-merged-by-patch-id.ts

mod +1 / -1

Same one-line import switch so the per-commit cherry-check git calls during sync cleanup also log under --verbose.

```typescript
import { execa } from '../exec';
```

### packages/cli/src/lib/progress.ts

mod +16 / -0

Adds Progress.stop(): halts the underlying SingleBar without forcing it to total (unlike complete() which prints a deceptive 100% on error paths). Clears bar/state/activeProgress so subsequent start()s start fresh. Noop implementation is a function-shaped no-op so CI/non-TTY callers don't branch on TTY-ness.

```typescript
stop() {
  if (bar) bar.stop();
  bar = null;
  state = null;
  paused = false;
  if (activeProgress === progress) activeProgress = null;
}
```

### packages/cli/src/commands/sync.ts

mod +32 / -6

Creates one Progress instance and drives three phases: '🌲 Fetching branches' (uses the new fetchBranches onBranchStart to update per-branch), '🧹 Cleaning merged' (per-deletion update), '🔄 Reconciling' (per-branch update). Wraps the existing try/catch in a finally that calls progress.stop() so an exception can't orphan the bar. Wraps the auto-clean console.log inside the cleanup loop with pause/resume. confirm() and choose() now pause+resume the active bar via getActiveProgress(), which covers the trunk-sync path too (no bar active = pause/resume are no-ops on null).

```typescript
} catch (error) {
  pendingError = await wrapSyncError(error, cwd);
} finally {
  progress.stop();
}
```

### packages/cli/src/commands/submit.ts

mod +161 / -88

Splits the body into two progress phases: '🚀 Pushing branches' (start before the push loop, complete after) and '📬 Syncing PRs' (start before the getPr/createPr loop, complete after). Wraps the entire body in try/finally with progress.stop() so the bar is always cleaned up even if pushBranch, getPr, or createPr throws. Dry-run callers still bypass the bar — phase start/complete is gated on !dryRun. updateAllPrBodies runs after both bars complete so its own console output (none currently) stays clean.

```typescript
const progress = createProgress();
try {
  if (!dryRun && plan.branches.length > 0) {
    progress.start('🚀 Pushing branches', plan.branches.length);
  }
  // ...
  return result;
} finally {
  progress.stop();
}
```

### packages/cli/src/commands/restack.ts

mod +92 / -12

executeRestackSteps detects whether it owns the bar (no active progress -> create one) vs runs under a parent like sync (active progress -> stay silent). When owning, starts '🥞 Restacking' with pendingSteps.length as total and updates per branch. Wraps the entire loop in try/finally with bar?.stop() so conflict paths, success paths, and unexpected throws all clean up the bar without forcing 100%. The conflict early-return now relies on the finally instead of inlined complete() calls.

```typescript
const ownsBar = getActiveProgress() == null;
const bar = ownsBar ? createProgress() : null;
if (bar && pendingSteps.length > 0) bar.start('🥞 Restacking', pendingSteps.length);
// ...
try {
  // for-loop, conflict early-return, success
} finally {
  bar?.stop();
}
```

### packages/cli/src/lib/sync/report.ts

mod +4 / -0

printBranchOutcome now consults getActiveProgress() and pauses+resumes the bar around the console.log. Keeps the public signature unchanged so every existing call site (cleanup loop, reconcile loop, recordWorktreeSkip) participates automatically.

```typescript
const progress = getActiveProgress();
if (progress) progress.pause();
console.log(outcome.message);
if (progress) progress.resume();
```

### packages/cli/src/lib/sync/report.test.ts

new +98 / -0

Three tests pin the pause/resume contract: (1) bare console pass-through when no progress is active, (2) TTY-mode bar writes increase across the pause/resume cycle (proves the bar was stopped and restarted around the log), (3) non-TTY progress is a no-op so stream writes stay empty even when printBranchOutcome fires.

```typescript
it('pauses and resumes the active TTY progress around the print', () => {
  const stream = createFakeStream(true);
  const progress = createProgress({ stream: stream as unknown as NodeJS.WriteStream, isTTY: true, ci: false });
  progress.start('🔄 Reconciling', 3);
  const writesBefore = stream.writes.length;
  printBranchOutcome(outcome);
  expect(stream.writes.length).toBeGreaterThan(writesBefore);
});
```

### packages/cli/src/lib/exec.test.ts

new +44 / -0

Two tests for the new execa wrapper: it runs the subprocess unchanged when verbose is off (no `$ node` lines on stderr), and it prints a sanitized command line with verbose on (https://user:secret@... rewritten to https://[REDACTED]@...). Uses a real child process (`node -e 'process.stdout.write("ok")'`) so we exercise the actual execa code path.

```typescript
setVerbose(true);
await execa('node', ['-e', 'process.stdout.write("ok")', 'https://user:secret@example.com/repo.git']);
expect(combined).toContain('[REDACTED]@example.com');
expect(combined).not.toContain('secret');
```

### packages/cli/src/lib/progress.test.ts

mod +21 / -5

Adds a stop() test (bar halts, activeProgress cleared, second stop() is a no-op). Updates the existing pause/resume mock progress fixture to satisfy the now-required stop() method on the Progress interface.

```typescript
progress.start('working', 10);
progress.update('working', 3, 'feat/a');
expect(getActiveProgress()).toBe(progress);
progress.stop();
expect(getActiveProgress()).toBeNull();
```

### packages/cli/src/commands/sync.test.ts

mod +6 / -1

Updates the fetchBranches assertion to match the new four-arg call shape (branches, cwd, 'origin', { onBranchStart }). expect.objectContaining keeps the test resilient to additional opts later.

```typescript
expect(mockFetchBranches).toHaveBeenCalledWith(['main', 'feat/a'], '/repo', 'origin', expect.objectContaining({ onBranchStart: expect.any(Function) }));
```

## Where to focus review

1. **Cleanup-on-error contract via Progress.stop()** - `packages/cli/src/lib/progress.ts:99-150, sync.ts:181-735, submit.ts:150-252, restack.ts:185-250`: cli-progress sets hideCursor: true. If a phase throws and the bar is never stopped, the user's shell prompt loses its cursor. The pattern here is: every command that creates progress wraps its body in try { ... } finally { progress.stop(); } (or bar?.stop()) so even an unexpected throw cleans up. stop() differs from complete() by not forcing the bar to 100% — important when the cause of the exit is an error, not success.
2. **Pause/resume around every print or readline that runs during a bar** - `packages/cli/src/lib/sync/report.ts:5-9, sync.ts:59-90 (confirm/choose), sync.ts:296-303 (cleanup auto-clean log)`: Three classes of writes coexist with the bar: per-branch outcome lines (printBranchOutcome), auto-clean info lines inside the cleanup loop, and interactive prompts (confirm/choose). All three now pause+resume the bar — the helpers delegate to getActiveProgress() so they're correct whether a bar is active or not, and whether the caller is sync, restack, or future callers.
3. **lib/exec.ts as the single seam for git/gh subprocess tracing** - `packages/cli/src/lib/exec.ts, git.ts:1-5, github.ts:1-4, git/is-merged-by-patch-id.ts:1`: Rather than touching all 50+ execa call sites, the import for execa was switched to a thin wrapper that calls logVerboseCommand before invoking the real execa. The cast preserves execa's overloaded type signatures so stdout/stderr typing keeps working unchanged at the call sites. The wrapper is opt-in: support-bundle.ts, conflict-ui.ts, etc. still import from 'execa' directly because they are not the git/gh subprocesses the AC calls out.

## Test plan

- [x] **unit:** lib/sync/report.test.ts — 3 tests for printBranchOutcome pause/resume - all green; covers no-active-progress, TTY active progress (writes grow across pause/resume), non-TTY noop progress
- [x] **unit:** lib/exec.test.ts — 2 tests for the verbose execa wrapper - all green; uses real `node -e ...` subprocess to verify off=silent / on=sanitized print
- [x] **unit:** lib/progress.test.ts — adds stop() coverage; pre-existing 15 tests still green - 16 tests, all green; verifies stop() clears activeProgress and is idempotent
- [x] **unit:** whole-repo vitest - 76 files, 609 tests passed in 6.4s
- [x] **manual:** dub --verbose log smoke test outside an initialized repo - prints `$ git rev-parse --abbrev-ref HEAD` / `$ git rev-parse --show-toplevel` before each subprocess, confirming the exec wrapper is on the path for git.ts subprocess calls

## Quality gates

- **biome (lint + format):** `pnpm checks` - passed (Checked 218 files, no fixes applied)
- **typecheck:** `pnpm typecheck` - passed (turbo: dubstack:typecheck OK, docs:typecheck cache hit)
- **unit tests:** `pnpm test` - passed (76 test files, 609 tests passed in 6.45s)
- **build:** `pnpm build` - passed (tsup ESM build success)
- **evals:** `pnpm evals` - not_available (Pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch (127 vs 137) blocks local runs (same as DUB-3). AGENTS.md only requires evals when AI metadata/prompts change; this PR touches neither.)

## Self-QA

See [QA fallback evidence](.reports/dub-12-qa.md).

Two-pass adversarial review (both critical findings + one major from pass 2 all fixed), 609 unit tests green, manual --verbose smoke test confirming subprocess tracing reaches git.ts. Cleanup-on-error contract via Progress.stop() in try/finally for all three commands. All interactive prompts and console.log paths that run while a bar is active now pause+resume via getActiveProgress().

- sync creates one bar per phase (fetch / cleanup / reconcile) and stops it in a finally so a thrown exception cannot leave hideCursor on
- submit creates two bars (push / PR sync) and stops them in a finally; dry-run bypasses both bars
- restack detects whether it owns the bar via getActiveProgress(); when called from sync after reconcile has completed, it creates its own bar and stops it in a finally regardless of conflict/success/unexpected throw
- printBranchOutcome pauses+resumes the active bar around its console.log so per-branch outcome lines do not tear the bar
- sync's auto-clean console.log inside the cleanup loop is wrapped in pause/resume
- sync's confirm() and choose() helpers pause+resume the active bar via getActiveProgress(); works correctly whether a bar is active (reconcile loop) or not (roots loop)
- fetchBranches gained an onBranchStart callback fired before each per-branch fetch so sync can update the bar with the current branch name as detail
- every git and gh subprocess routes through lib/exec.ts, which calls logVerboseCommand before invoking execa — visible as `$ git ...` / `$ gh ...` lines under --verbose, sanitized of basic-auth and token query params
- non-TTY / CI callers go through the no-op Progress, so existing summary-only output is preserved

## Acceptance criteria

- [x] dub sync shows progress bars for fetch / cleanup / reconcile / restack phases - sync.ts starts/updates/completes a bar in each of the three local phases. The restack phase calls restack(cwd) which manages its own bar via executeRestackSteps (ownsBar branch). All four phases visible in TTY.
- [x] dub submit shows progress for push and PR create/update phases - submit.ts L150-203 — '🚀 Pushing branches' and '📬 Syncing PRs' bars, each updated per branch and completed before the next phase.
- [x] dub restack shows progress per step - restack.ts executeRestackSteps — '🥞 Restacking' bar with total = pendingSteps.length and one update per branch. Owns/borrows the bar based on getActiveProgress().
- [x] Per-branch outcome lines do not collide with the progress bar (use progress.pause() around prints) - lib/sync/report.ts printBranchOutcome pauses+resumes via getActiveProgress(); sync cleanup loop wraps its auto-clean console.log similarly; sync confirm()/choose() helpers pause+resume around their readline interaction.
- [x] In non-TTY mode no progress UI, just summary lines - createProgress() returns a no-op when !isTTY || ci (progress.ts createNoopProgress); every consumer goes through this factory; pause/resume/start/update/complete/stop are all silent no-ops; existing console.log summary lines are unaffected. Covered by lib/sync/report.test.ts 'is a no-op for progress writes in non-TTY mode' and the existing lib/progress.test.ts non-TTY tests.
- [x] --verbose prints every subprocess command, pausing the progress bar - lib/exec.ts wraps execa; calls logVerboseCommand(file, args, { progress: getActiveProgress() }) before invoking the subprocess; sanitizes URLs via sanitizeRemoteUrl. git.ts, github.ts, and git/is-merged-by-patch-id.ts all import from lib/exec. Verified via the `node packages/cli/dist/index.js --verbose log` smoke test which prints `$ git rev-parse ...` for each call.
- [x] Tests: verify TTY-mode renders one bar at a time, non-TTY mode renders summary lines only - lib/sync/report.test.ts (3 tests) + lib/progress.test.ts existing TTY / non-TTY tests cover both modes; lib/exec.test.ts (2 tests) covers verbose on/off.

## Adversarial review

Iterations: 2

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Pass 1 critical (fixed): orphaned progress bars on error paths in sync.ts — any exception thrown inside fetch/cleanup/reconcile lands in the catch without stopping the active bar, leaving the cursor hidden. Fix: added Progress.stop() and wrapped all three command bodies in try/finally that calls progress.stop() / bar?.stop().
- Pass 1 critical (fixed): raw console.log calls during active cleanup bar in sync.ts (L297-L302). Fix: wrapped in progress.pause() / progress.resume().
- Pass 2 major (fixed): confirm() and choose() inside the reconcile loop wrote to the terminal while the '🔄 Reconciling' bar was active. Fix: both helpers now call getActiveProgress()?.pause() at the top and ?.resume() in their finally — mirrors how printBranchOutcome handles it and works equally well for the trunk-sync loop where no bar is active.

## Dependencies

- **DUB-3 progress wrapper:** consumed (createProgress, logVerboseCommand, setVerbose, getActiveProgress all already shipped on main)
- **Progress.stop():** added in this PR (extension of the DUB-3 interface) — needed for safe error cleanup
- **fetchBranches onBranchStart callback:** added in this PR — optional, backward-compatible

## Rollout

Behavior change only in TTY sessions and under --verbose. CI / non-TTY usage goes through the same no-op Progress and produces identical output to before. Safe to merge.

- **On merge to main - TTY users see progress bars on sync/submit/restack:** Existing per-branch outcome lines still appear; the bar is added on top in TTY only.
- **On merge to main - --verbose now prints git/gh subprocess lines:** Sanitized via sanitizeRemoteUrl. No behavior change when --verbose is not passed.
- **Future slice - Wire progress into other long-running commands:** post-merge, prune, doctor --all could also adopt Progress; left out of scope per the DUB-12 spec.

## Commit

```text
feat(cli): wire progress bars into sync/submit/restack [DUB-12]
```
