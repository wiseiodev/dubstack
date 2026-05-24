## TL;DR

New `dub watch` CLI: poll-loop monitor that joins `getStackOverviewBatch` snapshots with `.git/HEAD`+`index`+cleanup-journal file events, fires diff-based notifications (review/CI/merged/trunk/branch-modified) via platform-native tools, and respects cleanup-journal / offline / HTTP 429 pause gates. Zero new npm deps.

## Why

Today users learn about PR review flips, CI failures, and trunk advances only by re-running `dub log` or refreshing the GitHub web UI.

DUB-25 already paid the cost of a rich batched stack overview; a passive process can amortize that cache into proactive nudges.

Out-of-band edits to `.git/HEAD`/`.git/index` (manual checkouts, raw commits) leave Dubstack state silently stale; a watcher can surface those instantly.

### Before

- No long-lived process existed in the CLI — every signal was on-demand.
- `getStackOverviewBatch` was wired into `dub log`/`dub co` but had no automated caller.
- Cleanup-journal recovery state was inspected only by the `dub continue`/`dub abort` flow.

### After

- `dub watch` keeps a 60s poll cycle (configurable) reusing the same batched fetch.
- Desktop notifications fire on PR review/CI/merge flips, trunk advance, and current-branch SHA changes.
- Active cleanup journals automatically pause GitHub polling so the watcher does not interfere with recovery.

## File-by-file

### packages/cli/src/lib/duration.ts

new +30 / -0

Parses `30s`/`2m`/`1h`/`250ms` (or bare-int ms) into milliseconds for the new --interval flag and renders the inverse for log lines. Returns null on bad input so callers can emit their own DubError instead of catching a generic throw.

```ts
export function parseDuration(input: string | undefined | null): number | null {
  if (input == null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(trimmed);
  if (!match) return null;
  ...
}
```

### packages/cli/src/lib/notify.ts

new +92 / -0

Platform-aware desktop notification: osascript on macOS, notify-send on Linux, PowerShell base64 `-EncodedCommand` on Windows. The Windows path encodes title/message via `[char]NNN+...` literals after a critical-finding fix so user-controlled strings (branch names, PR titles) cannot escape into PowerShell code. Failures are swallowed so the watcher keeps running.

```ts
if (os === 'win32') {
  const script = buildBalloonTipScript(notification);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execa('powershell', ['-NoProfile', '-EncodedCommand', encoded]);
  return true;
}
```

### packages/cli/src/lib/watch.ts

new +507 / -0

Core orchestrator. Pure `diffSnapshots()` computes events between successive `WatchSnapshot`s (PR review/CI/merged, trunk-advanced, branch-modified). `createWatcher()` factory wires injectable deps (fetch, gh-auth, file watch, timer, notify, getCurrentBranch, getOriginShas, now) so the loop is fully testable without real timers or fs. Coalesces concurrent file+timer triggers behind a `polling` flag so overlapping events cannot spawn parallel poll chains (fixed during adversarial review). Pause matrix: cleanup-journal → offline → rate-limited (exponential 30s→5m), with auto-resume.

```ts
if (polling) {
  // Coalesce concurrent triggers: mark a follow-up and bail. The
  // in-flight poll will re-fire once on drain via runPoll().
  pollPendingFollowup = true;
  return { events: [], skipped: pause?.reason ?? null };
}
```

### packages/cli/src/commands/watch.ts

new +235 / -0

CLI wiring + production dependency wiring. `buildWatcher()` accepts overrides for tests; `watch()` registers SIGINT/SIGTERM handlers and hangs on an unresolved Promise until a signal exits. `defaultRenderUi` uses ANSI cursor controls (avoid pulling in ink/blessed). `defaultGetOriginShas` runs `git rev-parse --verify --quiet refs/remotes/origin/<root>` per stack root.

```ts
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
await watcher.start();
await new Promise<void>(() => {});
```

### packages/cli/src/index.ts

mod +23 / -0

Registers the `dub watch` subcommand with `--interval <duration>` and `--ui` flags.

```ts
program
  .command('watch')
  .description('Long-lived monitor: polls GitHub + watches .git for stack-state changes')
  .option('--interval <duration>', 'Poll interval — duration like 30s, 2m (default 60s)')
  .option('--ui', 'Render the live TUI status pane')
```

### packages/cli/src/lib/watch.test.ts

new +440 / -0

17 tests covering `diffSnapshots` (six event kinds + first-poll baseline), `renderEvent` copy assertions, and `createWatcher` orchestration (interval scheduling, file-event dispatch, cleanup pause/resume, offline auto-pause, 429 backoff, end-to-end pr-merged event, stop() cleanup, and the concurrent-trigger coalescing race added after review).

### packages/cli/src/lib/duration.test.ts

new +47 / -0

Unit tests for the duration parser/formatter.

### packages/cli/src/lib/notify.test.ts

new +59 / -0

Routing + escape tests for the desktop-notify helper.

### packages/cli/src/commands/watch.test.ts

new +39 / -0

Tests that --interval validation rejects malformed inputs and sub-5s intervals with actionable DubError messages, and that buildWatcher returns a usable handle.

## Where to focus review

1. **Concurrent-trigger coalescing in createWatcher** - `packages/cli/src/lib/watch.ts:319-475`: A file event coinciding with a timer fire previously spawned two parallel `schedule()` chains, effectively halving the configured poll interval. The `polling` + `pollPendingFollowup` flags now serialize concurrent triggers. Reviewers: confirm the follow-up drain logic does not stall when stop() is called between trigger and drain.
2. **PowerShell injection surface on Windows** - `packages/cli/src/lib/notify.ts:38-58`: Original implementation used single-quote escaping inside the -Command flag. Critical reviewer finding flagged that PowerShell expression characters (dollar-sign, backtick, dollar-paren-subexpression) survived single-quote escaping. Replaced with -EncodedCommand over a base64'd UTF-16LE script whose strings are reconstructed character-by-character via [char]NNN+... literals. Reviewers: validate that user-controlled branch names / PR titles cannot escape.
3. **Diff semantics — first poll baseline + current-branch SHA gating** - `packages/cli/src/lib/watch.ts:108-189`: `diffSnapshots(null, next)` returns no events (so startup does not spam every previously-seen state as 'new'); `branch-modified` fires only for the current branch (sibling SHAs flip on every restack and would otherwise be noise). Reviewers: confirm this matches the intended UX for first-launch quiet + ongoing signal.
4. **Pause matrix ordering — cleanup → offline → rate-limited** - `packages/cli/src/lib/watch.ts:367-407`: Cleanup pause is unconditional (user is mid-recovery), then offline (gh auth failure), then 429 backoff. Each pause auto-resumes when its precondition clears. Reviewers: walk through the auto-resume log lines to ensure the user always knows why the watcher is quiet.

## Test plan

- [x] **unit:** duration parser + formatter - packages/cli/src/lib/duration.test.ts (8 tests, all passing)
- [x] **unit:** notify routing + shell-escape safety - packages/cli/src/lib/notify.test.ts (4 tests covering darwin/linux/unsupported/failure)
- [x] **unit:** watch orchestration (poll interval, file dispatch, cleanup pause, offline, 429 backoff, stop, coalescing race) - packages/cli/src/lib/watch.test.ts (17 tests, all passing)
- [x] **unit:** command flag validation - packages/cli/src/commands/watch.test.ts (3 tests)
- [ ] **manual:** Run `dub watch --interval 5s --ui` in a live repo - Reviewer can exercise locally — no automation harness for a long-lived TUI process.

## Quality gates

- **Biome (lint + format):** `pnpm checks` - passed (Checked 283 files in 55ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (tsc --noEmit — 0 errors.)
- **Vitest:** `pnpm test` - passed (861/861 tests passing across 94 test files. 32 new tests added in this branch.)

## Self-QA

See [QA fallback evidence](.reports/dub-29-qa.md).

CLI-only long-lived process; QA evidence is the passing gate run + adversarial review trail.

- Three required gates pass: pnpm checks, pnpm typecheck, pnpm test (861/861).
- Adversarial review found 1 critical + 1 major + 1 important; all addressed before commit.
- Every acceptance criterion is covered by a test or a concrete code reference.

## Acceptance criteria

- [x] `dub watch` runs as a long-lived process - packages/cli/src/commands/watch.ts (watch() hangs on unresolved Promise until SIGINT/SIGTERM); wired in packages/cli/src/index.ts.
- [x] Polls GitHub at configured interval; respects rate limit with backoff - packages/cli/src/lib/watch.ts:436-447 schedule(); 429 backoff at :408-419 (30s → 5m exponential); test 'backs off and pauses on HTTP 429 from the overview fetch'.
- [x] Watches `.git/HEAD`, `.git/index`, and `.git/dubstack/cleanup-journal.json` - packages/cli/src/lib/watch.ts watchedFiles list; defaultWatchFiles uses fs.watch with persistent:false; test 'subscribes to .git file events that drive an immediate re-poll'.
- [x] Pauses polling while a cleanup journal is active - packages/cli/src/lib/watch.ts:367-374; tests 'pauses polling while a cleanup journal is active' + 'resumes after the cleanup journal clears'.
- [x] Desktop notifications on PR state changes, trunk advance, branch modification - packages/cli/src/lib/watch.ts diffSnapshots + renderEvent emit pr-review-changed / pr-ci-changed / pr-merged / trunk-advanced / branch-modified; notify shells out via lib/notify.ts; test 'emits a pr-merged event end-to-end and forwards it to notify+log'.
- [x] Exponential backoff on 429; auto-pause on offline - packages/cli/src/lib/watch.ts:386-407; tests 'auto-pauses when gh auth fails (offline)' + 'backs off and pauses on HTTP 429'.
- [x] `--ui` shows TUI status pane - packages/cli/src/commands/watch.ts defaultRenderUi (ANSI cursor controls); flag wired in index.ts.
- [x] Graceful shutdown on SIGINT/SIGTERM - packages/cli/src/commands/watch.ts:226-234 process.once handlers call watcher.stop(); test 'stop() releases the timer and file-watcher handles'.
- [x] Tests: poll interval, file watcher dispatch, cleanup-journal pause, graceful shutdown - packages/cli/src/lib/watch.test.ts covers all four (and adds 13 more) — 17 passing tests.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- (critical, fixed) PowerShell injection in lib/notify.ts Windows path — single-quote escaping did not neutralize PowerShell expression chars (dollar, backtick, dollar-paren-subexpression). Now uses -EncodedCommand with base64'd UTF-16LE script whose strings are reconstructed via [char]N+... literals so no user content reaches the PowerShell parser as code.
- (major, fixed) `schedule()` re-entry race in lib/watch.ts — concurrent file + timer triggers could spawn parallel poll chains. Added `polling` + `pollPendingFollowup` flags and a `runPoll` inner function to serialize triggers and fire one fan-in follow-up on drain.
- (important, addressed) Missing race coverage — added 'coalesces concurrent file + timer triggers into a single in-flight poll' test that verifies peakInFlight stays at 1 across overlapping triggers.
- (important, declined) SIGINT/SIGTERM listener accumulation only matters if `watch()` is called multiple times in the same process without exiting; current callers always exit via `process.exit(0)` inside the signal handler. Leaving `process.once` as-is.

## Dependencies

- **DUB-25 (Batched PR/CI data layer):** Done — getStackOverviewBatch + 30s on-disk cache available and reused by the watcher.
- **DUB-76 (cleanup-journal lib promotion):** Done — detectActiveOperation returns 'cleanup' so watch can pause.
- **DUB-2 (retry helper):** Done — runGh already wraps with exponential backoff; the watcher additionally pauses on persistent 429s.

## Rollout

Additive new subcommand. Zero changes to existing commands or state files. Safe to ship behind no flag.

- **On merge - No data migration needed:** `dub watch` only reads `.git/dubstack/state.json` and the existing `overview-cache.json`. It writes nothing to disk.
- **First user run - Documentation:** Add a `dub watch` section to README/QUICKSTART in a follow-up PR (out of scope for this change per the issue spec).
- **Follow-up - Optional ETag/If-None-Match:** Spec mentions dropping to `gh api` directly so cache hits don't count against rate limit. Deferred — the existing 30s overview cache + exponential 429 backoff already absorb most pressure.

## Commit

```text
feat(watch): add `dub watch` long-lived stack monitor [DUB-29]
```
