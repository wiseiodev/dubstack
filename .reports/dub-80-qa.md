# Self-QA fallback - dub-80

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-80 is a structural refactor of a private TypeScript function (extracting
`status()` from `commands/mcp.ts` into `commands/status.ts`). There is no
browser surface, no TUI, and no CLI output to record. The function is consumed
only by the `dubstack.status` MCP JSON-RPC tool, whose behavior is unchanged.

## What was verified

- `pnpm checks` (biome lint + format): passed.
- `pnpm typecheck`: passed (turbo, cli + docs packages).
- `pnpm test`: 792 tests across 87 files, all passing — includes the existing
  `mcp.test.ts` coverage for the `dubstack.status` tool registration, and the
  three new shape tests in `commands/status.test.ts`:
  - tracked branch (healthy drift, OPEN PR with baseRefName)
  - untracked branch (empty stack metadata, drift healthy)
  - missing gh auth (rejected PR fetch → `state: 'UNKNOWN'` with `error`)
- `git diff --staged` confirms the inline `status()` body was deleted from
  `mcp.ts` (line 774 region) and replaced with a single-line import + call site
  at the `dubstack.status` case, wrapped through the existing `toJsonValue` so
  the MCP JSON envelope is bit-identical except for the additive
  `schemaVersion: 1` field required by the issue spec.

## Evidence

- `packages/cli/src/commands/status.ts` — new module with `StatusResult`,
  `BranchSnapshot`, `PrSnapshot`, `DriftSnapshot`, `StatusOptions`, `status()`,
  `isDriftIssue()`.
- `packages/cli/src/commands/status.test.ts` — three shape tests, mocks
  follow the pattern used by `commands/doctor.test.ts`.
- `packages/cli/src/commands/mcp.ts` — inline impl deleted, imports trimmed,
  `case 'dubstack.status'` invokes the shared module.
- Adversarial code review (feature-dev:code-reviewer) raised one MAJOR finding
  about silently-ignored `StatusOptions` fields; addressed with an inline
  comment marking them reserved for DUB-28.

## Follow-up flag

DUB-28 will wire `live` and `pr` into the new `dub status` CLI; this issue
stops at the structural move per the spec's explicit non-goal.
