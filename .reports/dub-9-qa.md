# Self-QA fallback - DUB-9

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

No `.tsx` files changed and the feature is a CLI stdio MCP server plus MDX docs. The useful proof is protocol-level subprocess verification and repo gates, not a browser recording.

## What was verified

- Spawned `dub mcp`, sent `initialize`, `tools/list`, and `tools/call` for `dubstack.log`.
- Asserted the advertised read-only tools and structured stack JSON response shape.
- Asserted MCP `tools/call dubstack.log` is appended to `dub history` for audit.
- Verified `dub log --json` uses the same JSON stack helper consumed by the MCP tool.
- Ran the required repo gates.

## Evidence

- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed, including `packages/cli/src/commands/mcp.test.ts`.

## Follow-up flag

None.
