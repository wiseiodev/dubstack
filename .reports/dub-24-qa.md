# Self-QA fallback - DUB-24

> This work item is a CLI-only change with no browser surface, so this file
> replaces the video and records deterministic proof instead.

## Why no video

No `.tsx` files changed. The work is entirely in the Node.js CLI (`packages/cli/src/commands/submit.ts`, `index.ts`, `mcp.ts`, `ready.ts`, `merge-next.ts`) and Markdown docs. Browser automation cannot demonstrate CLI argument parsing or scope-flag mutual exclusion.

## What was verified

1. **`pnpm checks`** — Biome lint + format: 246 files clean.
2. **`pnpm typecheck`** — `tsc --noEmit` across both packages: zero diagnostics.
3. **`pnpm test`** — Vitest: **696 tests in 84 files, all passing**, including the seven new tests in `submit-tree.test.ts` exercising every scope (default, `--upstack`, `--downstack`, `--branch <name>`, `--stack`), mutual-exclusion validation, and both `--path` deprecation warnings.
4. **Built CLI smoke tests** (`node packages/cli/dist/index.js submit ...`):
   - `submit --help` shows all four new flags + deprecated `--path` + deprecated `--fix` (correct help text).
   - `submit --dry-run --upstack --downstack` exits with `Scope flags are mutually exclusive: --upstack, --downstack.` (mutex enforcement works).
   - `submit --dry-run --path current` prints `⚠ '--path current' is deprecated. Use '--downstack' instead. This will stop working in v2.` then proceeds (deprecation warning on stderr, behavior preserved).

## Evidence

- Diff stat: 21 files, +423/-95.
- Implementation: `packages/cli/src/commands/submit.ts` lines 44-82 (types), 333-403 (`resolveScope`), 405-451 (scope dispatch + upstack BFS).
- Tests: `packages/cli/test/commands/submit-tree.test.ts` covers each scope kind, the mutex error, and both deprecation warnings.
- Adversarial review (feature-dev:code-reviewer subagent): no critical/major findings.

## Follow-up flag

None. Two-release deprecation window for `--path` per the issue; the v2 removal is a future task.
