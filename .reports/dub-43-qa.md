# Self-QA fallback - DUB-43

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

No `.tsx` files changed and the feature is CLI/provider wiring, shell env writing, docs, tests, and CI eval configuration. There is no browser-demoable surface for this issue.

## What was verified

- Anthropic provider resolution, default model, repo/env model override, and auto-chain placement are covered in `packages/cli/src/lib/ai-provider.test.ts`.
- `dub ai env --anthropic-key` and `--anthropic-model` shell-profile writing are covered in `packages/cli/src/commands/ai-env.test.ts`.
- `dub ai setup` Anthropic selection and global model env behavior are covered in `packages/cli/src/commands/ai-setup.test.ts`.
- Config parser support for `anthropic` provider and model overrides is covered in `packages/cli/src/commands/config.test.ts` and `packages/cli/src/lib/config.test.ts`.
- CI now contains an Anthropic-backed `pnpm evals` step that runs when `DUBSTACK_ANTHROPIC_API_KEY` is configured.

## Evidence

- `pnpm typecheck` passed.
- `pnpm test` passed: 113 files, 1128 tests.
- `pnpm checks` passed.
- `pnpm evals` was attempted and failed before scoring because no local AI provider key is configured in this shell. The failure was `AI assistant has no configured provider`, with no `DUBSTACK_GEMINI_API_KEY`, `DUBSTACK_ANTHROPIC_API_KEY`, or `DUBSTACK_AI_GATEWAY_API_KEY` present.

## Follow-up flag

Local live eval scoring still needs an AI provider key. CI is wired to run the suite against Anthropic when the `DUBSTACK_ANTHROPIC_API_KEY` secret exists.
