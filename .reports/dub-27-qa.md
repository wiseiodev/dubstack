# Self-QA fallback - DUB-27

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub co` is a non-TSX TTY CLI prompt. Headless browser tooling can't drive it,
and a terminal recording would be visually similar to the screenshots in the
acceptance-criteria evidence below. The full behavior is exercised by the new
unit/integration tests against the `@inquirer/testing` harness, which simulates
the same keypress stream the real TTY would generate.

## What was verified

- `pnpm checks` — biome lint+format (passed, 281 files checked).
- `pnpm typecheck` — `tsc --noEmit` across the monorepo (passed).
- `pnpm test` — full vitest run, 93 files / 859 tests passing (was 90/830
  before this change; 3 new test files + 29 new tests).
- New tests cover all 5 shortcuts (`Enter`, `p`, `d`, `c`, `Esc`), fuzzy
  filter behavior, footer rendering, "no match" state, "search input takes
  precedence over shortcuts" guard, and the regression where pressing
  arrow keys with only a disabled row matching used to spin forever.
- `pnpm cli:dev co --help` smoke-tested the new `--refresh` and
  `--no-color` flags wire through Commander correctly.

## Evidence

- Commit: `2fc24d1`
- Test files added:
  - `packages/cli/src/lib/branch-picker.test.ts` (11 tests)
  - `packages/cli/src/lib/branch-picker-format.test.ts` (8 tests)
  - `packages/cli/src/lib/clipboard.test.ts` (5 tests)
  - 5 new cases in `packages/cli/src/commands/checkout.test.ts`
- Docs: `apps/docs/content/docs/commands/checkout.mdx`

## Follow-up flag

None. Background "Loading PR data..." refresh-while-rendering (note #3 in
the issue's implementation section, not a hard acceptance criterion) was
intentionally simplified to a synchronous fetch with a single `Loading PR
data...` line printed when `--refresh` is in use. The 30s cache TTL means
the wait is paid at most once every 30s; user-perceived latency is near
zero on warm cache, which already satisfies "Cached data renders
instantly."
