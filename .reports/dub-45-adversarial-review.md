# Adversarial Review - DUB-45

## Scope

Reviewed the staged diff for DUB-45, focused on provider-resolution coverage,
command dependency wiring, config/env compatibility, and local endpoint failure
behavior.

## Iteration 1

### Major finding fixed

- `packages/cli/src/commands/ready.ts` had a separate default AI dependency
  bundle for `dub ready --ai`. The initial staged diff updated the shared
  provider types and most AI command surfaces, but did not pass
  `createOpenAICompatible` into readiness review. That meant a repository pinned
  to `ollama` would fail readiness review with "Ollama support is unavailable in
  this build" even though the provider worked elsewhere.

### Fix applied

- Added `createAnthropic`, `createOpenAI`, and `createOpenAICompatible` to the
  readiness AI dependency bundle so readiness review matches the provider set
  supported by the shared resolver.
- Re-ran `pnpm checks`, `pnpm typecheck`, and `pnpm --filter dubstack test --
  ready ai-provider`.

## Remaining findings

- Critical: 0
- Major: 0
- Minor: 0
- Nitpick: 0

## Notes

- `pnpm evals` was attempted after rebuilding `better-sqlite3`; it remains
  blocked by the local environment having no configured hosted AI provider and
  no running local Ollama/LM Studio endpoint.
