# Self-QA fallback - DUB-45

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-45 changes TypeScript CLI provider plumbing, shell-profile env handling,
interactive AI setup, eval provider wiring, and markdown docs. No `.tsx` files
or browser-demoable UI surfaces changed.

## What was verified

- `ollama` is a supported repo AI provider and model-override target.
- Runtime provider resolution creates an OpenAI-compatible Ollama/LM Studio
  provider, maps default Ollama base URLs to `/v1`, preserves explicit `/v1`
  LM Studio endpoints, and checks local reachability before prompts run.
- `dub ai setup` includes Ollama, checks endpoint reachability, and writes
  `DUBSTACK_OLLAMA_BASE_URL` plus optional global model defaults.
- `dub ai env` writes and normalizes Ollama base URL/model exports.
- Existing AI commands that resolve providers receive the new
  `createOpenAICompatible` dependency, including readiness review.
- Documentation now calls out local model quality caveats.

## Evidence

- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`
- `pnpm --filter dubstack test -- ready ai-provider` after adversarial review
  caught and verified the readiness dependency seam.
- `pnpm evals` was attempted after rebuilding `better-sqlite3`; it is blocked
  by this local environment having no configured AI provider or reachable local
  Ollama/LM Studio endpoint.

## Follow-up flag

None for the implementation. Running the eval suite requires configuring one of
the supported AI provider env paths or starting a local Ollama/LM Studio server.
