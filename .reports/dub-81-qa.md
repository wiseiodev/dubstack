# Self-QA fallback - DUB-81

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-81 ships repository docs and Biome GritQL lint plugins. There is no CLI
behavior change to demo and no UI surface to record. Verification is best
expressed as the lint command running against synthetic positive cases and
the real codebase.

## What was verified

1. **All three rules fire on a positive-test fixture** containing one bare
   `new DubError(msg)`, one `execa('gh', ...)`, and one `execa('git',
   ['push', '--force', ...])`. Each produced a distinct `plugin` diagnostic
   pointing at the offending span.
2. **All three rules pass clean against `packages/cli/src`** after
   upgrading 7 bare `DubError` sites to include recovery hints
   (`mcp.ts` ×1, `sync.ts` ×2, `track.ts` ×2, `untrack.ts` ×1, `git.ts` ×1).
3. **Allowlist regexes are path-anchored.** `lib/errors.ts`, `lib/github.ts`,
   and `lib/git.ts` are exempt; sibling files of the same name elsewhere in
   the tree (e.g. a future `commands/errors.ts`) would still trip the rule.
4. **Multi-line bare-DubError detection.** Earlier draft used a comma-substring
   heuristic that missed multi-line single-arg calls with a trailing comma.
   Replaced with `$args <: [$msg]` list-destructure, which correctly catches
   both inline and multi-line single-argument constructions.
5. **`.test.ts` and `lib/errors.ts` allowlist** prevents the
   bare-DubError rule from blowing up legitimate test fixtures and the
   `DubError` constructor smoke test.
6. **Repo gates green.** `pnpm checks`, `pnpm typecheck`, `pnpm test`
   (863 tests across 93 files) all pass.

## Evidence

- Lint command run from repo root:
  ```
  $ pnpm checks
  $ biome check .
  Checked 285 files in 142ms. No fixes applied.
  ```
- Typecheck:
  ```
  $ pnpm typecheck
  ...
  Tasks:    2 successful, 2 total
  ```
- Tests:
  ```
  $ pnpm test
  ...
  Test Files  93 passed (93)
       Tests  863 passed (863)
  ```
- Positive-test fixture (manually constructed under `/tmp/positive-test.ts`,
  not committed):
  ```ts
  import { execa } from 'execa';
  import { DubError } from './errors';
  throw new DubError('boom');
  execa('gh', ['pr', 'list']);
  execa('git', ['push', '--force', 'origin', 'main']);
  ```
  Result: 3 plugin diagnostics, one per rule, plus 1 unrelated `noUnreachable`.

## Follow-up flag

None. The lint rules will surface any future bare-DubError, direct `gh`, or
raw `git push --force` introduced by Tier 3 command authors before merge.
