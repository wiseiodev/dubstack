---
name: dub-flow-evals
description: Use when changing AI-generated branch, commit, or PR metadata for DubStack flow, or when adding new local Evalite coverage for those outputs.
---

# Dub Flow Evals

Use this skill when `dub flow` metadata quality could change and you need to validate it with the local Evalite harness.

## When To Use

- Prompt or rubric changes in `packages/cli/src/lib/ai-metadata.ts`
- `dub flow` behavior changes that affect generated branch names, commit messages, or PR descriptions
- Template-preservation changes for commit or PR bodies
- New edge cases that should become permanent eval fixtures

## Quick Run

```bash
pnpm evals
pnpm evals:watch
pnpm evals:export
```

The first suite lives at `packages/cli/evals/dub-flow-metadata.eval.ts`.

## Core Pattern

Target the pure helper, not the mutating command:

- evaluate `generateFlowMetadata(...)`
- keep git mutation coverage in tests
- keep generation quality coverage in Evalite

This keeps the eval deterministic enough to debug while still exercising the exact AI path shipped by `dub flow`.

## Case Design

Each case should include:

- `parentBranch`
- `stagedDiff`
- optional `commitTemplate`
- optional `prTemplate`
- optional unrelated-noise text for negative assertions

Prefer curated diffs over giant real snapshots. Keep enough signal for the model to infer intent, but not so much noise that failures become hard to interpret.

Add cases for:

- new product behavior
- template edge cases
- regressions found in review or user reports
- confusing diffs where the model might overfit to tests/docs instead of the feature

## Scoring Pattern

Use a hybrid scorer set:

- deterministic contract scorers for branch format, conventional commit subject, template heading preservation, no markdown fences, and non-empty content
- keyword/focus checks for must-mention and must-not-mention terms
- one AI judge scorer for overall reviewer usefulness and diff fidelity

Do not score exact wording. That makes the suite brittle and rewards prompt overfitting instead of better metadata.

## Implementation Notes

- Reuse existing DubStack AI env vars. Do not add eval-only secrets unless absolutely necessary.
- Keep the judge prompt strict about JSON output and parse failures as low scores with metadata.
- Prefer adding a new scorer only when a failure mode is structural. If the issue is general quality, strengthen the judge rubric or add a focused case first.

## Important Nuance

Do not enable `traceAISDKModel` in this repo's Evalite suite unless you verify compatibility first.

The current stack uses `ai@6`, and the traced-model path caused Evalite SQLite trace persistence failures during setup. Plain AI SDK calls work for the suite today, so start there and only reintroduce tracing after confirming it stores cleanly.

## Workflow

1. Add or update a case in `packages/cli/evals/dub-flow-metadata.eval.ts`.
2. Run `pnpm evals`.
3. If the failure is structural, add or refine a deterministic scorer.
4. If the failure is quality-related, improve the prompt/helper or judge rubric.
5. Re-run `pnpm evals:watch` while iterating.
6. Export a report with `pnpm evals:export` when you want a shareable artifact.

## Common Mistakes

- Evaluating `flow.ts` end-to-end instead of the pure helper
- Writing exact-string assertions into eval scorers
- Letting tests/docs noise dominate the expected intent
- Adding new env vars for the judge when existing provider config already works
- Treating a judge-score dip as prompt-only work when the real issue is missing structural validation
