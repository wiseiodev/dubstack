# Self-QA fallback - DUB-48

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-48 changes the TypeScript CLI command path and MDX command docs. No `.tsx`
files changed and there is no browser-demoable interaction to record.

## What was verified

- `dub ready` keeps the existing doctor + submit preflight behavior.
- `dub ready --ai` gathers parent-relative diff, commit messages, optional PR body, and runs the AI readiness helper per scoped branch.
- `dub ready --ai` does not treat a missing pre-submit PR description as a readiness failure.
- Critical AI findings block readiness unless `--ai-skip-review` is set.
- Major/minor AI findings remain warnings.
- `--scope current|downstack|stack` continues to select the same branch set for the AI review.
- JSON output includes the AI review payload.
- The requested docs page exists at `apps/docs/content/docs/commands/ready.mdx`.

## Evidence

- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed after merging the latest `origin/main`: 119 files / 1184 tests.
- Focused tests passed: `pnpm --filter dubstack exec vitest run src/commands/ready.test.ts src/lib/ai-readiness.test.ts`.
- `pnpm evals` was attempted and failed before running assertions because no AI provider is configured in this environment.

## Follow-up flag

No follow-up required for CLI behavior. Evals should be rerun in an environment
with `DUBSTACK_GEMINI_API_KEY`, `DUBSTACK_AI_GATEWAY_API_KEY`, or Bedrock
provider variables configured.
