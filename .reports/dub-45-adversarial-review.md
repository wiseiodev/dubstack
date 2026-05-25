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

## Follow-up review after PR creation

- The external two-reviewer workflow could not run because the local `claude`
  CLI returned `401 Invalid authentication credentials`.
- I performed a second local adversarial pass against the PR diff and found a
  coverage gap: the production `checkOllamaEndpoint` helper had an error-path
  test but did not directly assert the happy-path curl URL for Ollama
  `/api/tags` or LM Studio `/v1/models`.
- Added focused tests for both URL shapes in
  `packages/cli/src/lib/ai-provider.test.ts`.

## Copilot review follow-up

Classified all three Copilot review threads as valid and fixed them:

- Added a specific DubError when `curl` is unavailable, so users do not get a
  misleading endpoint-unreachable message for a missing local dependency.
- Made `dub ai setup` fall back to the built-in Ollama base URL when an existing
  `DUBSTACK_OLLAMA_BASE_URL` value is invalid, so setup can recover instead of
  crashing before the user can correct it.
- Added `checkOllamaEndpoint` to `AiMetadataDependencies` so eval dependency
  overrides match the resolver contract explicitly.

Re-ran `pnpm checks`, `pnpm typecheck`, and `pnpm test`.

## Notes

- `pnpm evals` was attempted after rebuilding `better-sqlite3`; it remains
  blocked by the local environment having no configured hosted AI provider and
  no running local Ollama/LM Studio endpoint.
