## TL;DR

Extracted the private status() function from commands/mcp.ts into a new commands/status.ts module with a typed StatusResult interface, so DUB-28 (dub status CLI) can consume the same impl. The dubstack.status MCP tool's behavior is unchanged aside from an additive schemaVersion: 1 field required by the spec.

## Why

DUB-28 (dub status CLI) is blocked on having a shared, typed entrypoint that both the MCP tool and the CLI command can call.

Keeping status() inline in commands/mcp.ts forced duplication or a circular import once a CLI command was added.

### Before

- commands/mcp.ts owned a private async status(cwd) returning a loose JsonValue.
- There was no shared status module; the MCP tool was the only caller and the impl was not type-safe across consumers.

### After

- commands/status.ts owns the impl, exports a typed StatusResult, and is the single source of truth.
- commands/mcp.ts imports status() and wraps it through toJsonValue at the call site; inline impl deleted.
- DUB-28 can now add a dub status CLI command by importing the same status() function.

## File-by-file

### packages/cli/src/commands/status.ts

new +98 / -0

New shared module. Exports StatusResult (with schemaVersion: 1, currentBranch, operation, branch, pr, drift), BranchSnapshot, PrSnapshot, DriftSnapshot, StatusOptions (live/pr reserved for DUB-28), the async status(cwd, options?) function, and isDriftIssue() helper. Body is the same logic that previously lived inline in mcp.ts, returning a typed object instead of a JsonValue.

```typescript
export interface StatusResult {
  schemaVersion: 1;
  currentBranch: string | null;
  operation: ActiveOperation;
  branch: BranchSnapshot;
  pr: PrSnapshot;
  drift: DriftSnapshot;
}

export async function status(
  cwd: string,
  _options?: StatusOptions,
): Promise<StatusResult> { ... }
```

### packages/cli/src/commands/mcp.ts

mod +3 / -45

Deleted the inline status() and isDriftIssue() bodies. Imports the shared status() from ./status. The dubstack.status case now wraps the typed StatusResult through toJsonValue to keep the MCP JSON envelope identical. Trimmed unused imports (branchInfo, getBranchPrSyncInfo, DoctorIssue).

```typescript
import { status } from './status';

...

case 'dubstack.status':
  return jsonToolResult(toJsonValue(await status(cwd)));
```

### packages/cli/src/commands/status.test.ts

new +158 / -0

Three shape tests using the same mock pattern as commands/doctor.test.ts: tracked branch with healthy drift and OPEN PR, untracked branch with empty stack metadata, and missing-gh-auth path where getBranchPrSyncInfo rejects and status() returns pr.state = 'UNKNOWN' with the error message preserved.

```typescript
describe('status', () => {
  it('reports a tracked branch with healthy drift and PR info', ...);
  it('reports an untracked branch with empty stack metadata', ...);
  it('returns UNKNOWN pr state with error when gh auth is missing', ...);
});
```

## Where to focus review

1. **MCP behavior parity** - `packages/cli/src/commands/mcp.ts (dubstack.status case) + status.ts status()`: The extracted body must produce the same shape as before, modulo the additive schemaVersion: 1 field required by the spec. toJsonValue still wraps the result at the call site so the MCP JSON envelope is unchanged.
2. **Reserved options are visibly inert** - `packages/cli/src/commands/status.ts StatusOptions`: StatusOptions exists per the issue spec but its live/pr fields are intentionally not wired yet; an inline comment marks them reserved for DUB-28 so future callers don't expect them to filter behavior.
3. **Drift-issue filter still matches the original** - `packages/cli/src/commands/status.ts isDriftIssue()`: Code list (parent-mismatch, remote-base-mismatch, missing-local, missing-remote, remote-drift, remote-check-failed) is byte-identical to the old impl so MCP consumers see the same drift health signal.

## Test plan

- [x] **unit:** commands/status.test.ts (tracked, untracked, missing-gh-auth) - 3 new tests; full suite reports 792 passed across 87 files.
- [x] **unit:** Existing commands/mcp.test.ts unchanged - Tool registration still lists dubstack.status; MCP tests pass without modification.
- [x] **build:** pnpm typecheck (turbo cli + docs) - tsc --noEmit succeeded for both packages.

## Quality gates

- **Format + lint:** `pnpm checks` - passed (biome check . — Checked 263 files, no errors.)
- **Typecheck:** `pnpm typecheck` - passed (turbo typecheck — 2/2 packages successful.)
- **Unit tests:** `pnpm test` - passed (vitest — 87 files, 792 tests, all passing.)

## Self-QA

See [QA fallback evidence](.reports/dub-80-qa.md).

Deterministic proof: gates green, 792 tests green, MCP tool wiring unchanged.

- Shape: tracked branch returns populated stack metadata and OPEN PR info.
- Shape: untracked branch returns nulls/empties without throwing.
- Error path: rejected gh PR fetch yields pr.state = 'UNKNOWN' with error preserved.

## Acceptance criteria

- [x] commands/status.ts exists with typed StatusResult and status() export - New file at packages/cli/src/commands/status.ts.
- [x] commands/mcp.ts imports and invokes from the new module - import { status } from './status'; case 'dubstack.status' calls toJsonValue(await status(cwd)).
- [x] No behavior change for dubstack.status MCP tool - Returned shape is identical aside from the spec-required additive schemaVersion: 1 field; tool registration and JSON envelope are unchanged.
- [x] Existing MCP tests pass unchanged - commands/mcp.test.ts not modified; runs green in the 792-test suite.
- [x] New unit tests in commands/status.test.ts cover tracked, untracked, missing-gh-auth - Three describe-block cases match exactly.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- MAJOR (resolved): StatusOptions.live/pr were silently ignored. Addressed by adding an inline comment marking them reserved for DUB-28 so future callers know they are not yet wired.

## Dependencies

- **No external dependencies detected:** ok

## Rollout

Pure refactor — merge unlocks DUB-28; no runtime config or migration needed.

- **On merge - Land via squash merge:** No flags, no migrations. CI gates (lint, typecheck, tests) cover regression risk.
- **Follow-up - DUB-28 picks up status() to build `dub status` CLI:** DUB-28 will wire StatusOptions.live and StatusOptions.pr into the CLI command and add CLI-facing tests; this issue is structural only.

## Commit

```text
refactor(mcp): extract status() into shared commands/status.ts
```
