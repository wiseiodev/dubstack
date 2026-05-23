## TL;DR

New lib/progress.ts exports a Progress interface + createProgress() factory backed by cli-progress in TTYs and a no-op in CI/non-TTY. A global --verbose flag on the commander root is plumbed via preAction into a module-level flag, and logVerboseCommand prints the next subprocess (sanitized of basic-auth and token query params) while pausing the active bar so it redraws cleanly.

## Why

Tier 0 sync/submit/restack work needs a progress UI that survives CI logs.

Operators currently can't see which git/gh subprocess a command is about to run, which makes hangs and rate-limit failures hard to triage.

The wrapper has to land before any command consumes it so each consumer can be a focused diff.

### Before

- No shared progress primitive — each command logs ad-hoc lines.
- No way to trace subprocess invocations from the CLI without re-running under DEBUG/strace.
- Secret-bearing URLs would leak into logs if added naïvely.

### After

- createProgress() returns a TTY-aware bar or a no-op based on isTTY + CI detection.
- dub --verbose <cmd> sets a process-level flag any wrapped subprocess call can read.
- logVerboseCommand sanitizes URLs through support-bundle.ts:sanitizeRemoteUrl and pauses/resumes the active bar around each printed line.

## File-by-file

### packages/cli/src/lib/progress.ts

new +178 / -0

New file. Exports the Progress interface from the spec, a createProgress() factory that returns a cli-progress-backed bar in TTYs or a no-op when isTTY is false or CI is detected, and a verbose-mode helper (setVerbose / isVerbose / logVerboseCommand / formatVerboseCommandLine) that prints the next subprocess sanitized of basic-auth and token query parameters. pause()/resume() drive cli-progress' SingleBar by stopping and re-instantiating with the last state.

```typescript
export function createProgress(options: ProgressOptions = {}): Progress {
  const stream = options.stream ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean(stream.isTTY);
  const ci = options.ci ?? isCIEnvironment();
  if (!isTTY || ci) return createNoopProgress();
  return createTTYProgress(stream);
}
```

### packages/cli/src/lib/progress.test.ts

new +285 / -0

14 unit tests covering: no-op behavior in non-TTY and CI, TTY rendering + activeProgress registration, pause/resume semantics (including update-during-pause being silent and resume re-rendering), double-pause/resume no-ops, the global verbose flag toggle, no-op when verbose is off, sanitization of basic-auth credentials and token query params, pause/resume around the printed command line when a progress is supplied, fallback to activeProgress when no progress is passed, and formatVerboseCommandLine edge cases.

```typescript
it('pause clears output and resume resumes rendering', () => {
  // ...
  progress.pause();
  const writesAfterPause = stream.writes.length;
  progress.update('pushing', 3, 'feat/b');
  expect(stream.writes.length).toBe(writesAfterPause);
  progress.resume();
  expect(stream.writes.length).toBeGreaterThan(writesAfterPause);
});
```

### packages/cli/src/index.ts

mod +6 / -0

Adds the global --verbose option to the program root and a preAction hook line that pushes program.opts().verbose into setVerbose() before each command runs. Reads from program.opts() directly (not optsWithGlobals on the subcommand) so the modify command's existing -v/--verbose numeric counter does not shadow the global boolean.

```typescript
program.hook('preAction', () => {
  setVerbose(Boolean(program.opts().verbose));
  beginHistoryCapture();
});
```

### packages/cli/src/lib/support-bundle.ts

mod +1 / -1

Adds the export keyword to sanitizeRemoteUrl so the new progress wrapper can reuse it as the acceptance criterion requires. No behavior change.

```typescript
export function sanitizeRemoteUrl(url: string): string {
```

### packages/cli/package.json

mod +2 / -0

Adds cli-progress (runtime) and @types/cli-progress (dev) per the issue's recommended library choice. cli-progress is small, mature, has no React tree, and matches the start/update/stop semantics the spec implies.

```json
"cli-progress": "^3.12.0",
```

### pnpm-lock.yaml

mod +21 / -0

Lockfile entries for cli-progress and @types/cli-progress.

## Where to focus review

1. **Pause/resume state machine in createTTYProgress** - `packages/cli/src/lib/progress.ts:74-138`: cli-progress' SingleBar does not expose pause/resume natively, so pause() stops and nulls the bar while resume() rebuilds from the cached BarState. Verify there's no path where state becomes inconsistent: complete-while-paused, double-pause, resume-without-pause, start-twice, update-without-start.
2. **Global --verbose vs. modify command's local -v/--verbose counter** - `packages/cli/src/index.ts:96-100, 1289-1294, 1467-1470`: modify has a pre-existing -v/--verbose option that is a numeric counter for diff display. The preAction hook intentionally reads program.opts().verbose (not the subcommand opts) so the modify counter does not shadow the boolean. Confirm the global flag is reachable as dub --verbose <cmd>, and document the limitation that dub modify -v does not enable subprocess tracing.
3. **Secret sanitization scope of formatVerboseCommandLine** - `packages/cli/src/lib/progress.ts:161-178, packages/cli/src/lib/support-bundle.ts:506-513`: Reuses sanitizeRemoteUrl which redacts basic-auth and the {token,access_token,auth,key,secret} query keys. URL detection is limited to https:// / http:// — SSH URLs are passed through unmodified (sanitizer is a no-op for them). Less common token names (oauth_token, bearer, apikey) are not sanitized; this matches the existing support-bundle contract.

## Test plan

- [x] **unit:** progress.test.ts — 14 tests - pnpm test -- progress: 14/14 passed; covers TTY/CI branching, pause/resume, verbose toggle, sanitization, activeProgress fallback
- [x] **build:** tsup build of @dubstack/cli - tsup ESM build success (dist/index.js 310.22 KB)
- [x] **manual:** dub --help shows --verbose at root - node packages/cli/dist/index.js --help lists --verbose with the documented description

## Quality gates

- **biome (lint + format):** `pnpm checks` - passed (Checked 190 files in 48ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (turbo run typecheck: dubstack:typecheck OK, docs:typecheck cache hit)
- **unit tests:** `pnpm test` - passed (69 test files, 513 tests passed in 6.69s)
- **evals:** `pnpm evals` - not_available (Pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch (127 vs 137) blocks local evals run. AGENTS.md only requires evals when AI metadata/prompts change; this PR touches neither.)

## Self-QA

See [QA fallback evidence](.reports/dub-3-qa.md).

Deterministic proof via unit suite (14 progress.test.ts tests, all green), whole-repo gates (lint/typecheck/513 tests), CLI help end-to-end check, and an independent adversarial review whose two findings were both fixed.

- createProgress in non-TTY returns a no-op (no stream writes)
- createProgress in CI returns a no-op even when isTTY is true
- createProgress in a TTY writes to the stream and registers activeProgress; complete() clears it
- pause() stops rendering; update() during pause is silent; resume() re-renders the bar
- setVerbose toggles isVerbose; logVerboseCommand is silent when verbose is off
- logVerboseCommand sanitizes https://user:secret@host into [REDACTED]@host and redacts token=… query params
- logVerboseCommand pauses + resumes the supplied progress around the printed line
- logVerboseCommand falls back to the global activeProgress when none is supplied

## Acceptance criteria

- [x] packages/cli/src/lib/progress.ts exports a Progress interface and createProgress() factory - progress.ts:5-49 declares Progress and createProgress; both are re-exported from lib
- [x] TTY detection: full UI in TTY, no-op in CI - progress.ts:51-59 branches on isTTY + isCIEnvironment; covered by two no-op tests and one TTY-render test
- [x] --verbose flag plumbed through commander.js root so it's available to every command - index.ts:96-100 declares --verbose on program; index.ts:1467-1470 preAction copies into setVerbose; help text confirms presence at the root
- [x] Verbose mode integrates with progress (pauses bar while printing command lines) - logVerboseCommand calls progress.pause() before writing and progress.resume() after; falls back to activeProgress; covered by 'pauses and resumes' and 'falls back to active progress' tests
- [x] Sanitization of secrets in printed URLs (reuse support-bundle.ts:sanitizeRemoteUrl) - support-bundle.ts:506 now exports sanitizeRemoteUrl; formatVerboseCommandLine imports and applies it; covered by two sanitization tests and one no-op-for-non-URL test
- [x] Unit tests: TTY vs non-TTY, verbose flag propagation, pause/resume semantics - progress.test.ts: 14 tests across three describe blocks covering exactly these areas; all passing

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Fixed: looksLikeUrl no longer routes git@ SSH URLs into sanitizeRemoteUrl (it's a no-op for them — removing the branch eliminates a false promise).
- Fixed: 'logVerboseCommand falls back to active progress' test now actually exercises the activeProgress global fallback path (previously passed progress explicitly, contradicting the test name).
- Accepted as out-of-scope: dub modify -v continues to be a numeric counter for diff display, not subprocess tracing. The global flag is reachable as dub --verbose <subcommand>; unifying short-flag semantics is a separate UX change.

## Dependencies

- **cli-progress:** added (runtime, ^3.12.0) — recommended in the issue body
- **@types/cli-progress:** added (dev, ^3.11.6)
- **support-bundle.ts:sanitizeRemoteUrl:** now exported (one-line change, no behavior change)

## Rollout

Library-only change with no command consumers; safe to merge and ship in the next release without coordinated rollout.

- **On merge to main - No-op for existing commands:** createProgress is not yet called from any command and --verbose is a passive flag, so behavior of every existing command is unchanged.
- **Next slice - Wire into sync/submit/restack:** Subsequent issue should call createProgress() at the entry of each long-running command and route the execa/git/gh wrappers through logVerboseCommand so --verbose produces visible subprocess traces.

## Commit

```text
feat(cli): add tty-aware progress wrapper and --verbose global flag
```
