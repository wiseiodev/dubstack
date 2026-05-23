# Self-QA fallback - DUB-17

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-17 ships server-side and CLI-side code only: a stdio JSON-RPC MCP server
(`dub mcp`), the gating logic for mutating tools, a config subcommand
(`dub config mcp-mode <mode>`), and a documentation page. There is no browser
UI surface that a Playwright recording could meaningfully exercise — the user-
facing behavior is observed via JSON-RPC tool responses, terminal confirmation
prompts on the controlling TTY, and entries in `dub history`.

## What was verified

Each mode's behavior is asserted by in-process tests in
`packages/cli/src/commands/mcp.test.ts`:

- **read-only** — `refuses dubstack.create in read-only mode and audits the
  refusal` exercises the refusal payload (exact text from the issue) and
  asserts the refusal is audited in `dub history`, that the confirmation
  callback is **not** invoked, and that the current branch did not change.
- **interactive (confirm: true)** — `runs dubstack.checkout in interactive
  mode only after confirmation` asserts that the injected `ConfirmMutatingFn`
  is called with the tool name and args, and that the tool only executes once
  it returns `confirmed: true`.
- **interactive (confirm: false)** — `refuses in interactive mode when the
  user declines` asserts that a `confirmed: false` result short-circuits the
  tool, produces an `isError` response with the supplied reason, and leaves
  the working tree untouched.
- **trusted** — `runs dubstack.checkout in trusted mode without confirmation`
  asserts that the confirmation callback is **not** invoked and that the
  tool actually executes (current branch changes).

Tool catalog is asserted by the existing
`lists tools, calls dubstack.log, and audits the invocation` test, updated to
expect all six new mutating tools alongside the original read-only seven.

Config behavior is asserted in `packages/cli/src/commands/config.test.ts` —
inspect / read-only / interactive / trusted persistence, idempotent re-set,
and invalid-mode rejection with the documented recovery message.

Default config (no file) is asserted in `packages/cli/src/lib/config.test.ts`
to include `mcpMode: 'interactive'`.

## Evidence

- `pnpm checks` — biome lint+format: 215 files, no errors.
- `pnpm typecheck` — `tsc --noEmit` across the dubstack and docs packages: 0 errors.
- `pnpm test` — vitest: **612/612** tests pass across **74** test files (suite
  duration ~9 s, no flakes observed).
- Direct rerun of `pnpm --filter dubstack test --run src/commands/mcp.test.ts`:
  5/5 tests pass (includes the original integration test spawning a real
  `dub mcp` subprocess).

## Follow-up flag

None. All issue acceptance criteria satisfied. The defensive re-entry guard
on `mutatingToolResult` (added in response to adversarial review) protects
against future callers nesting stdio capture; today the per-line `queue`
already serializes tool calls.
