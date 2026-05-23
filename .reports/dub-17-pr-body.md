## TL;DR

Adds 6 mutating MCP tools (create/modify/submit/sync/checkout/delete) gated by a new `dub config mcp-mode` setting with three modes: read-only (refusal payload), interactive (default; /dev/tty y/n prompt), trusted (no prompt). Every invocation — success, refusal, error — is audited in `dub history`. Docs page rewritten to cover the security model.

## Why

Unlock the full leverage of `dub mcp` for agent workflows by letting agents drive Dubstack, not just read it.

Keep humans in the loop by default — the security model defaults to interactive confirmation so agents cannot silently mutate repos.

Give power users an explicit opt-in (`trusted`) and a safety hatch (`read-only`) without code changes.

### Before

- `dub mcp` only exposed read-only tools (log, doctor, status, parent, children, trunk, history).
- Agents had no way to create branches, commit, submit PRs, sync, checkout, or delete via MCP — they had to shell out.
- There was no per-repo config for how aggressive MCP-driven automation should be.

### After

- `dub mcp` exposes 13 tools total — 7 read-only plus 6 mutating: `dubstack.create`, `dubstack.modify`, `dubstack.submit`, `dubstack.sync`, `dubstack.checkout`, `dubstack.delete`.
- `dub config mcp-mode <read-only|interactive|trusted>` persists per-repo. Default is `interactive`.
- Refusals in `read-only` match the issue's documented payload exactly. Interactive mode prompts on `/dev/tty`; if no controlling terminal exists, the tool refuses with a clear recovery message. All paths land in `dub history`.

## File-by-file

### packages/cli/src/lib/config.ts

mod +12 / -0

Adds the `McpMode` type, the `mcpMode` field on `DubConfig` (default `interactive`), and `normalizeMcpMode` so invalid stored values fall back to the default.

```typescript
export type McpMode = 'read-only' | 'interactive' | 'trusted';

export interface DubConfig {
  aiAssistantEnabled: boolean;
  mcpMode: McpMode;
  ai: { /* ... */ };
}

function normalizeMcpMode(value: unknown): McpMode {
  if (value === 'read-only' || value === 'interactive' || value === 'trusted') {
    return value;
  }
  return DEFAULT_CONFIG.mcpMode;
}
```

### packages/cli/src/commands/config.ts

mod +50 / -1

Adds `configMcpMode(cwd, mode?)` and `parseMcpMode`. Returns current mode when no arg, writes and reports `changed` when set, throws a DubError with recovery steps for invalid modes.

```typescript
export async function configMcpMode(
  cwd: string,
  mode?: string,
): Promise<ConfigMcpModeResult> {
  const config = await readConfig(cwd);
  if (mode == null) {
    return { mode: config.mcpMode, changed: false };
  }
  const parsed = parseMcpMode(mode);
  const changed = config.mcpMode !== parsed;
  if (changed) {
    await writeConfig({ ...config, mcpMode: parsed }, cwd);
  }
  return { mode: parsed, changed };
}
```

### packages/cli/src/index.ts

mod +28 / -3

Wires the new `dub config mcp-mode <mode>` subcommand and updates the `dub mcp` description to note that mutating tools are gated by the configured mode.

```typescript
new Command('mcp-mode')
  .argument('[mode]', 'Set to read-only/interactive/trusted (omit to inspect current value)')
  .description('Manage the security model for mutating MCP tool calls (default: interactive)')
  .action(async (mode?: string) => {
    const { configMcpMode } = await import('./commands/config');
    const result = await configMcpMode(process.cwd(), mode);
    // ...
  })
```

### packages/cli/src/commands/mcp.ts

mod +385 / -3

The core of the change. Adds 6 mutating tool definitions, mode-gating in `handleToolCallRequest`, a `/dev/tty` confirmation prompt, an injectable `ConfirmMutatingFn` for testability, stdout/stderr capture (with a re-entry guard) so command logs cannot corrupt the JSON-RPC stream, audit-history coverage for refusals, and `HISTORY_ARG_KEYS` for the new tools.

```typescript
if (tool.mutating) {
  const mode = await resolveMcpMode(cwd);
  if (mode === 'read-only') {
    const text = `${name} refused: repo is in read-only MCP mode. Run \`dub config mcp-mode interactive\` to enable mutating tools.`;
    await appendMcpHistory(cwd, name, args, startedAt, 'error', [text]);
    return jsonRpcResult(request.id ?? null, {
      content: [{ type: 'text', text }],
      isError: true,
    });
  }
  if (mode === 'interactive') {
    const confirmation = await confirmMutating(name, args);
    if (!confirmation.confirmed) {
      await appendMcpHistory(cwd, name, args, startedAt, 'error', [confirmation.reason]);
      return jsonRpcResult(request.id ?? null, {
        content: [{ type: 'text', text: confirmation.reason }],
        isError: true,
      });
    }
  }
}
```

### packages/cli/src/commands/mcp.test.ts

mod +253 / -6

Adds a `mcp mutating tools` describe block with four in-process tests using PassThrough streams and an injected `ConfirmMutatingFn` stub: read-only refusal (+ audit assertion), trusted bypass, interactive confirm-true execution, interactive confirm-false refusal. Updates the existing `tools/list` assertion to include the six new tool names.

```typescript
const confirm = vi
  .fn<ConfirmMutatingFn>()
  .mockResolvedValue({ confirmed: true, reason: 'ok' });
const response = await runMcpCall(dir, confirm, {
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'dubstack.checkout', arguments: { branch: 'main' } },
});
expect(confirm).toHaveBeenCalledWith('dubstack.checkout', { branch: 'main' });
expect(await getCurrentBranch(dir)).toBe('main');
```

### packages/cli/src/commands/config.test.ts

mod +36 / -0

Covers `configMcpMode`: default `interactive`, set to `read-only` / `trusted`, idempotent re-set, and invalid-mode rejection with the documented recovery message.

```typescript
describe('config mcp-mode', () => {
  it('returns the default interactive mode when no mode is set', async () => {
    const result = await configMcpMode(dir);
    expect(result).toEqual({ mode: 'interactive', changed: false });
  });
  // ...
});
```

### packages/cli/src/lib/config.test.ts

mod +1 / -0

Updates the `returns defaults when config file is missing` assertion to include the new `mcpMode: 'interactive'` field.

```typescript
expect(config).toEqual({
  aiAssistantEnabled: false,
  mcpMode: 'interactive',
  ai: { /* ... */ },
});
```

### apps/docs/content/docs/guides/mcp.mdx

mod +58 / -3

Rewrites the MCP docs to split read-only vs mutating tool tables, document the `dub config mcp-mode` security model with the three modes, show the exact refusal payload, and explain the `/dev/tty` confirmation flow.

```markdown
## Security model

Choose how aggressive the agent's automation is for this repository:

```bash
dub config mcp-mode read-only    # only read tools work; mutating tools return a refusal payload
dub config mcp-mode interactive  # mutating tools require explicit y/n confirmation in the dub mcp terminal (DEFAULT)
dub config mcp-mode trusted      # mutating tools run without confirmation
```
```

## Where to focus review

1. **Mode gating order** - `packages/cli/src/commands/mcp.ts: handleToolCallRequest (lines ~454-510)`: Critical safety boundary. Confirm that (a) unknown tools are rejected before the mode check, (b) read-only short-circuits with the exact refusal text from the issue, (c) interactive blocks execution when `confirmed: false`, and (d) refusals are audited as `error` entries in `dub history`.
2. **stdout/stderr capture safety** - `packages/cli/src/commands/mcp.ts: mutatingToolResult (lines ~673-730)`: The mutating tools delegate to existing CLI command functions that may `console.log`. Without capture, those writes would corrupt the JSON-RPC channel on stdout. The `stdioCaptureActive` re-entry guard was added in response to adversarial review — verify the `try/finally` always restores originals and that the guard throws (not silently corrupts) if nested.
3. **/dev/tty prompt + TTY-absent fallback** - `packages/cli/src/commands/mcp.ts: confirmMutatingTool`: On macOS/Linux `/dev/tty` is the controlling terminal even when stdio is piped (the typical `claude mcp add dubstack dub mcp` shape). Verify the fd is closed after readline and that the no-TTY branch returns a refusal with a clear recovery (`dub config mcp-mode trusted` or `read-only`).
4. **Config schema normalization + default** - `packages/cli/src/lib/config.ts: normalizeMcpMode + DEFAULT_CONFIG.mcpMode`: Default must be `interactive` (per issue) and invalid stored values must fall back rather than throw.

## Test plan

- [x] **unit:** config mcp-mode CRUD + invalid input (config.test.ts) - 5 new tests in packages/cli/src/commands/config.test.ts cover default, read-only set, trusted set, idempotent re-set, and invalid value rejection.
- [x] **integration:** MCP mode gating + audit for each mode (mcp.test.ts) - 4 new in-process tests (PassThrough streams + injected confirm stub): read-only refusal + audit, trusted bypass, interactive confirm-true execution, interactive confirm-false refusal.
- [x] **integration:** Spawned dub mcp subprocess still lists tools + handles read-only call - Existing `lists tools, calls dubstack.log, and audits the invocation` test (updated to expect the 6 new mutating tool names) still passes against a real `tsx src/index.ts mcp` child.
- [x] **unit:** Default config schema includes mcpMode='interactive' - packages/cli/src/lib/config.test.ts `returns defaults when config file is missing` updated and passing.

## Quality gates

- **Lint + format:** `pnpm checks` - passed (biome check . — Checked 215 files, no fixes applied.)
- **Type check:** `pnpm typecheck` - passed (turbo run typecheck — 2/2 tasks successful, dubstack + docs.)
- **Unit + integration tests:** `pnpm test` - passed (vitest — 612/612 tests pass across 74 test files in ~9s.)

## Self-QA

See [QA fallback evidence](.reports/dub-17-qa.md).

Deterministic proof: per-mode behavior asserted by 4 in-process MCP tests + spawn integration test for read-only tools; config CRUD asserted by 5 unit tests; full gate suite (lint + typecheck + 612 vitest tests) green.

- read-only: dubstack.create returns the exact refusal payload from the issue, audit entry recorded, working tree untouched.
- interactive (declined): dubstack.checkout aborts when ConfirmMutatingFn returns confirmed=false, working tree untouched.
- interactive (confirmed): dubstack.checkout switches branch after ConfirmMutatingFn returns confirmed=true.
- trusted: dubstack.checkout runs immediately; ConfirmMutatingFn is never invoked.
- tools/list now exposes the 6 new mutating tools alongside the original 7 read-only tools.
- Config: default is interactive; set / re-set / invalid input behave as documented.

## Acceptance criteria

- [x] All listed mutating tools implemented and exposed via tools/list - TOOLS array in packages/cli/src/commands/mcp.ts includes dubstack.create/modify/submit/sync/checkout/delete with `mutating: true`. Existing tools/list test asserts all 13 names in order.
- [x] dub config mcp-mode <mode> subcommand exists and persists the choice - New Command('mcp-mode') wired in packages/cli/src/index.ts; configMcpMode writes via writeConfig; 5 unit tests confirm persistence + invalid-input rejection.
- [x] In read-only mode, mutating tools return the refusal payload - Test `refuses dubstack.create in read-only mode` asserts the exact text from the issue (`dubstack.create refused: repo is in read-only MCP mode. Run \`dub config mcp-mode interactive\` to enable mutating tools.`) and isError=true.
- [x] In interactive mode, mutating tools prompt in the controlling terminal before executing - confirmMutatingTool opens /dev/tty via fs.openSync + readline.createInterface; ConfirmMutatingFn injection lets tests assert the prompt is invoked with (name, args) before the tool runs.
- [x] In trusted mode, mutating tools execute immediately - Test `runs dubstack.checkout in trusted mode without confirmation` asserts the confirm stub is never called and the branch actually changes.
- [x] Every mutating tool invocation creates a dub history entry - appendMcpHistory is called for success (line ~508), refusal (read-only + interactive-declined, line ~486 / ~495), and error (line ~519). Test `refuses dubstack.create in read-only mode` explicitly asserts the audit row exists.
- [x] Tests: each mode's behavior verified for at least one mutating tool - 4 new tests in mcp.test.ts cover read-only (dubstack.create), interactive accept + decline (dubstack.checkout), trusted (dubstack.checkout).
- [x] Docs updated: apps/docs/content/docs/guides/mcp.mdx covers the security modes - Rewritten to split read-only / mutating tool tables, document the three modes with example commands, show the exact refusal payload, and explain /dev/tty confirmation. Docs typecheck still passes.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Critical (resolved): mutatingToolResult monkey-patches process.stdout/stderr globally; concurrent invocation could leak the patch. Fixed by adding a `stdioCaptureActive` re-entry guard that throws if nested — defensive even though the per-line queue already serializes calls.
- Minor (acknowledged, not fixed): in-process tests briefly swallow vitest output via the stdout patch. Window is tiny (one quiet `checkout()` call) and vitest test files run serially within a worker, so in practice diagnostics are not lost.

## Dependencies

- **DUB-9 — dub mcp server with read-only tools:** Done — provides the JSON-RPC server scaffolding, tool registration, and audit hook this slice extends.

## Rollout

Ship behind the existing `dub mcp` command. Default mode is `interactive`, so existing agents that already call read-only tools get the new mutating surface only after the user explicitly types `y` at the controlling terminal. No migration needed.

- **On merge - No-op for current MCP users:** Read-only tools and their wire formats are unchanged. Users who never call mutating tools see no difference.
- **First mutating call - Interactive prompt on /dev/tty:** User sees `[dub mcp] Allow dubstack.<tool> (...args)? [y/N]` in the terminal pane where `dub mcp` is running and confirms with `y`.
- **Opt-in to higher automation - dub config mcp-mode trusted:** Power users who fully trust their agent can skip prompts. Anyone wanting to lock down a sensitive repo can flip to `read-only`.

## Commit

```text
feat(mcp): mutating tools + config mcp-mode security model
```
