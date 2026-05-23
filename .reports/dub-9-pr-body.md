## TL;DR

Adds `dub mcp`, a dependency-free stdio MCP server exposing read-only DubStack tools, plus `dub log --json`, audit history for MCP tool calls, a spawned integration test, and docs for installing the server.

## Why

MCP lets Claude Code and other MCP-aware agents inspect a tracked DubStack repository through typed tool calls instead of free-form shell commands.

Keeping the first slice read-only provides useful agent context while leaving mutation confirmation policy to the next slice.

### Before

- DubStack had CLI commands for stack inspection, but no MCP server or tool schema surface.
- `dub log` only rendered an ASCII tree, so agents had no canonical structured stack-tree shape to consume.
- There was no per-tool audit trail for agent-driven DubStack inspection.

### After

- `dub mcp` speaks newline-delimited stdio JSON-RPC with `initialize`, `tools/list`, `tools/call`, `ping`, and `notifications/initialized` support.
- Seven read-only tools return JSON through MCP `content` and `structuredContent`, reusing existing command helpers where possible.
- `dub log --json` and `dubstack.log` share the same structured stack-tree helper.
- Every MCP `tools/call` appends a dedicated entry to `dub history`.

## File-by-file

### packages/cli/src/commands/mcp.ts

new +494 / -0

Implements the stdio JSON-RPC MCP server, tool registry, tool dispatch, structured JSON responses, status aggregation, and per-tool history audit. Request handling is queued so responses are deterministic and buffered requests flush before EOF exit.

```ts
const TOOLS: ToolDefinition[] = [
  { name: 'dubstack.log', description: 'Return the tracked DubStack stack tree as structured JSON.', inputSchema: { /* ... */ } },
  { name: 'dubstack.doctor', description: 'Return DubStack health issues and remediation steps.', inputSchema: { /* ... */ } },
  { name: 'dubstack.status', description: 'Return current branch, tracking, PR state, and drift issues.', inputSchema: EMPTY_SCHEMA },
];
```

### packages/cli/src/index.ts

mod +34 / -4

Wires the new top-level `dub mcp` command and adds `--json` support to both `dub log` and `dub ls`, printing the same JSON helper consumed by the MCP log tool.

```ts
program
  .command('mcp')
  .description('Start the DubStack read-only MCP server over stdio')
  .action(async () => {
    await mcp(process.cwd(), { version });
  });
```

### packages/cli/src/commands/log.ts

mod +126 / -24

Adds `logJson` and JSON branch/tree types while preserving existing ASCII rendering behavior. Shared stack selection keeps `--stack`, `--all`, and `--reverse` semantics consistent between text and JSON output.

```ts
export interface LogJsonBranch {
  name: string;
  type: 'root' | 'branch';
  parent: string | null;
  current: boolean;
  exists: boolean;
  prNumber: number | null;
  prLink: string | null;
  children: LogJsonBranch[];
}
```

### packages/cli/src/commands/mcp.test.ts

new +201 / -0

Integration test spawns the MCP server with `tsx`, sends `initialize`, `tools/list`, and `tools/call dubstack.log`, asserts the structured response shape, and confirms the call appears in `dub history`.

```ts
server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dubstack.log', arguments: {} } });
const logResponse = await server.nextJson();
expect(logResult.structuredContent).toMatchObject({ currentBranch: 'feat/a' });
```

### packages/cli/src/commands/log.test.ts

mod +54 / -1

Adds coverage for the JSON tree helper so `dub log --json` and `dubstack.log` have a locked response shape with current branch, branch existence, PR number, parent, and children metadata.

### apps/docs/content/docs/guides/mcp.mdx

new +58 / -0

New guide documents the Claude install command, available read-only tools, audit history behavior, and supported MCP JSON-RPC methods.

```bash
claude mcp add dubstack dub mcp
```

### apps/docs/content/docs/guides/meta.json

mod +1 / -0

Adds the MCP guide to the docs navigation.

### apps/docs/content/docs/commands/log.mdx

mod +4 / -0

Documents the new `dub log --json` flag alongside existing stack/all/reverse options.

### .reports/dub-9-qa.md

new +26 / -0

Self-QA fallback artifact because no `.tsx` files changed and the feature is proven through protocol-level subprocess tests and repo gates rather than a browser recording.

## Where to focus review

1. **MCP stdout safety** - `packages/cli/src/commands/mcp.ts`: Stdio MCP requires stdout to contain only JSON-RPC messages. The server writes protocol messages directly and does not use console logging in the MCP command path.
2. **Audit semantics** - `packages/cli/src/commands/mcp.ts:365`: Every `tools/call` appends a `dub mcp tools/call <name>` history entry independently of the long-running `dub mcp` process lifecycle.
3. **Shared log JSON shape** - `packages/cli/src/commands/log.ts:67`: `dubstack.log` delegates to `logJson`, the same helper used by `dub log --json`, so the MCP and CLI JSON shapes cannot drift separately.

## Test plan

- [x] **integration:** Spawn MCP server and call `dubstack.log` - `packages/cli/src/commands/mcp.test.ts` starts `tsx src/index.ts mcp`, sends `initialize`, `tools/list`, and `tools/call dubstack.log`, then asserts response shape and history audit.
- [x] **unit:** JSON log helper shape - `packages/cli/src/commands/log.test.ts` asserts current branch, root/child nesting, branch existence, and PR number in `logJson`.
- [x] **manual:** MCP docs install path - `apps/docs/content/docs/guides/mcp.mdx` documents `claude mcp add dubstack dub mcp` and the exposed tools.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (Checked 201 files in 37ms. No fixes applied.)
- **Type check (turbo: docs + dubstack):** `pnpm typecheck` - passed (2 successful, 2 total. docs cache hit; dubstack ran `tsc --noEmit`.)
- **Full test suite:** `pnpm test` - passed (Test Files 72 passed (72); Tests 552 passed (552); docs tests passed 2/2.)

## Self-QA

See [QA fallback evidence](.reports/dub-9-qa.md).

Self-QA fallback covering MCP subprocess behavior, audit history, shared JSON log shape, and required repo gates.

- MCP server initializes and advertises the read-only tool list.
- `dubstack.log` returns the structured stack tree for a tracked branch.
- MCP tool invocation is appended to `dub history`.
- `dub log --json` uses the same `logJson` shape as `dubstack.log`.
- Required repo gates pass after the implementation and adversarial hardening.

## Acceptance criteria

- [x] New `packages/cli/src/commands/mcp.ts` implementing stdio JSON-RPC per the MCP spec - `mcp.ts` reads newline-delimited JSON-RPC from stdin, writes responses to stdout, and supports initialize/ping/tools/list/tools/call/initialized notification.
- [x] Tool schemas defined and exposed via `tools/list` MCP method - `TOOLS` registry defines JSON schemas; `tools/list` returns that registry. Verified in `mcp.test.ts`.
- [x] All read-only tools listed above return structured JSON - `callTool` implements `dubstack.log`, `dubstack.doctor`, `dubstack.status`, `dubstack.parent`, `dubstack.children`, `dubstack.trunk`, and `dubstack.history`; results include `structuredContent` and JSON text content.
- [x] `dubstack.log` returns the same shape as `dub log --json` - `dubstack.log` calls `logJson`; `dub log --json` prints `logJson`.
- [x] Every MCP tool invocation appears in `dub history` for audit - `appendMcpHistory` writes one history entry per `tools/call`; `mcp.test.ts` asserts `dub mcp tools/call dubstack.log` appears in history.
- [x] Integration test: spawn the MCP server, send `tools/list`, send a `tools/call dubstack.log`, assert response shape - `packages/cli/src/commands/mcp.test.ts` covers the spawned server protocol flow.
- [x] Docs page added at `apps/docs/content/docs/guides/mcp.mdx` - Guide added and linked from `apps/docs/content/docs/guides/meta.json`.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Reviewer flagged that request handling used fire-and-forget `handleLine` calls. Fixed by queueing request processing and waiting for the final buffered request before resolving on stdin EOF, preserving response order and one-shot piped request behavior.

## Dependencies

- **No external dependencies:** No external dependencies detected — Linear says blocked by none.

## Rollout

New read-only MCP surface behind an explicit `dub mcp` command. No migration and no mutating tools in this slice.

- **Install - Register MCP server:** Run `claude mcp add dubstack dub mcp` from a shell where `dub` is available.
- **Use - Ask for stack context:** MCP clients can call `dubstack.log`, `dubstack.status`, or the branch query tools from any initialized DubStack repo.
- **Follow-up - Add mutating tools with confirmation policy:** This slice intentionally excludes mutations. The next slice should settle the HITL default before exposing create/restack/submit operations.

## Commit

```text
feat: add read-only MCP server
```
