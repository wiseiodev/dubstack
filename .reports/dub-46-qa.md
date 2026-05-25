# Self-QA fallback - DUB-46

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-46 changes TypeScript CLI prompt behavior, repo-local config, and unit tests.
No `.tsx` files or browser-demoable surfaces changed.

## What was verified

- AI prompt choices are hidden unless the repo AI assistant is enabled and AI
  prompts are not off.
- Reconcile and restack prompt choice builders include the AI option only when
  explicitly requested by callers.
- AI prompt decisions parse streamed JSON, auto-accept high confidence when
  configured, and fall back to manual choices on low confidence.
- Repo-level config supports `ai-prompts` and `ai-prompts-auto-accept`.
- Existing sync, restack, post-merge, and config behavior remains covered by the
  full test suite.

## Evidence

- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`

## Follow-up flag

None.
