# Self-QA fallback - DUB-3

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

This change adds a non-UI CLI library (`packages/cli/src/lib/progress.ts`) and a
global commander flag. No `.tsx` files touched. No interactive command behavior
changed yet — this is the foundation slice the issue explicitly scopes as
"no command changes here yet". A terminal recording of `dub --help` would not
demonstrate the new behavior (TTY vs. CI branching, pause/resume, sanitization).

## What was verified

1. **Unit suite, 14 tests, all green.** Covers:
   - TTY vs. non-TTY (no-op factory branch)
   - CI detection forcing no-op even in a TTY stream
   - TTY rendering writes to the stream and registers `activeProgress`
   - `pause()` stops rendering, `update()` during pause does not write, `resume()` re-renders
   - `pause()`/`resume()` are no-ops when not started / already paused
   - `setVerbose(true|false)` toggles `isVerbose()`
   - `logVerboseCommand` is silent when verbose is off
   - `logVerboseCommand` sanitizes `https://user:secret@host` basic-auth into `[REDACTED]@host`
   - `logVerboseCommand` pauses + resumes the supplied progress around the write
   - `logVerboseCommand` falls back to the global `activeProgress` when none is supplied
   - `formatVerboseCommandLine` redacts `token=…` query parameters

2. **Whole repo gates** (`pnpm checks`, `pnpm typecheck`, `pnpm test`): all green.
   - 69 test files, 513 tests passed
   - biome: 190 files, no fixes applied
   - tsc --noEmit: clean

3. **End-to-end help check.** Built the CLI with `tsup` and ran
   `node packages/cli/dist/index.js --help` — `--verbose` appears in the root
   options list with the documented description.

4. **Adversarial review.** Ran an independent code-reviewer agent against the
   staged diff. Two important findings addressed:
   - Dropped the `git@` SSH branch from `looksLikeUrl` (sanitizer is a no-op for
     SSH URLs; removing it avoids a false promise).
   - Rewrote the "active progress fallback" test to actually exercise the
     `activeProgress` global path (it previously passed `progress` explicitly).
   The "`dub modify -v` vs `dub --verbose modify` UX trap" finding was accepted
   as out-of-scope (pre-existing `-v` on `modify` is a numeric counter; this
   issue does not require unifying them, and the global flag is reachable as
   `dub --verbose <subcommand>`).

## Evidence

- `packages/cli/src/lib/progress.test.ts` — 14 tests, all assertions inlined
- `pnpm test` output: 513/513 passed
- `pnpm checks` output: clean
- `pnpm typecheck` output: clean
- `node packages/cli/dist/index.js --help` output: `--verbose` present

## Follow-up flag

- The acceptance criterion "Foundation for the progress reporting in
  sync/submit/restack slice — no command changes here yet" means there are no
  consumers in this PR. The next slice should wire `createProgress` into
  `submit`/`restack`/`sync` and call `logVerboseCommand` from the git/gh
  execa wrappers so `--verbose` produces visible output.
- `pnpm check:all` (which fans out to `pnpm evals`) fails locally on a
  pre-existing `better-sqlite3` NODE_MODULE_VERSION mismatch unrelated to this
  change. AGENTS.md only requires evals when AI metadata or prompts change;
  this PR touches neither.
