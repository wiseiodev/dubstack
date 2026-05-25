## TL;DR

Added a shared AI prompt decision flow and wired it into sync reconcile, unsubmitted/parent mismatch sync choices, restack conflict handling, and post-merge preferred-branch selection behind repo-local config.

## Why

DubStack already had AI provider plumbing and AI conflict resolution, but interactive recovery prompts still forced manual decisions.

DUB-46 requires AI options to stay hidden when AI is disabled, explain recommendations before applying, and preserve manual fallbacks.

### Before

- Reconcile and restack conflict prompts only rendered manual options.
- Unsubmitted branch and parent-mismatch sync prompts had no AI recommendation path.
- Config had no prompt-specific mode or high-confidence auto-accept control.

### After

- AI prompt choices are gated by `aiAssistantEnabled` plus `ai.prompts.mode`.
- A shared resolver streams the model response, validates the recommendation, auto-accepts configured high-confidence choices, and falls back to manual prompts for low/unsupported choices.
- Prompt builders and config commands are covered by focused unit tests plus the full existing suite.

## File-by-file

### packages/cli/src/lib/ai-prompt-decision.ts

new +263 / -0

Centralizes AI prompt recommendation streaming, JSON parsing, confidence handling, high-confidence auto-accept, and manual fallback behavior.

```ts
export async function resolveAiPromptDecision<T extends string>(input: {
```

### packages/cli/src/commands/sync.ts

mod +323 / -19

Adds AI decision choices to unsubmitted divergence, parent mismatch, three-way reconcile, and restack conflict paths while preserving non-interactive behavior.

```ts
const showAiPromptOptions = options.interactive
  ? await canShowAiPrompt(cwd)
  : false;
```

### packages/cli/src/commands/post-merge.ts

mod +135 / -2

Offers an AI pick when post-merge has multiple plausible checkout candidates after cleanup, using candidate commit and PR context.

```ts
message: 'Which branch should post-merge leave checked out?'
```

### packages/cli/src/commands/config.ts

mod +99 / -0

Adds `ai-prompts` and `ai-prompts-auto-accept` config surfaces with validation and persistence.

```ts
export async function configAiPrompts(
```

### packages/cli/src/lib/sync/reconcile-prompt.ts

mod +34 / -15

Adds testable prompt-choice construction and the optional AI choice while keeping the DUB-15 wording stable.

```ts
name: 'Let AI decide (shows reasoning before applying)'
```

### packages/cli/src/lib/restack-conflict-prompt.ts

mod +34 / -15

Adds the optional AI conflict-resolution choice and preserves non-interactive continue behavior.

```ts
name: 'Let AI resolve (shows reasoning before applying)'
```

### packages/cli/src/lib/ai-prompt-decision.test.ts

new +208 / -0

Covers AI prompt visibility gates, streamed recommendation parsing, high-confidence auto-accept, low-confidence fallback, and unsupported-choice fallback.

```ts
it('falls back to manual choices for unsupported recommendations', async () => {
```

## Where to focus review

1. **AI gating** - `packages/cli/src/lib/ai-prompt-decision.ts`: The AI option must remain hidden when the repo AI assistant is disabled and must not leak into manual-only flows.
2. **Sync recovery decisions** - `packages/cli/src/commands/sync.ts`: These paths mutate branches, reset refs, or pause recovery; the AI recommendation must never bypass existing safety semantics.
3. **Fallback behavior** - `packages/cli/src/lib/ai-prompt-decision.ts`: Low confidence, unsupported choices, and rejected recommendations should return to manual choices rather than applying unsafe output.

## Test plan

- [x] **unit:** AI prompt decision unit coverage - `packages/cli/src/lib/ai-prompt-decision.test.ts` covers gating, parsing, auto-accept, low-confidence fallback, and unsupported-choice fallback.
- [x] **unit:** Prompt rendering coverage - Reconcile and restack prompt tests assert AI choices are hidden by default and included only when requested.
- [x] **other:** Full regression suite - `pnpm test` passed with 114 files and 1140 tests.

## Quality gates

- **Biome checks:** `pnpm checks` - passed (Biome checked 285 files with no fixes applied.)
- **Typecheck:** `pnpm typecheck` - passed (Turbo typecheck passed for docs, dubstack, and dubstack-retarget-action.)
- **Tests:** `pnpm test` - passed (Turbo test passed; dubstack reported 114 test files and 1140 tests passing.)

## Self-QA

See [QA fallback evidence](.reports/dub-46-qa.md).

CLI-only QA fallback with deterministic command evidence.

- AI prompt choices hidden when AI is disabled.
- Prompt builders include AI choices only when requested.
- High-confidence auto-accept and low-confidence fallback are covered.
- Full repo checks, typecheck, and tests pass.

## Acceptance criteria

- [x] All four prompt sites offer the AI option when AI is enabled - Reconcile, unsubmitted/parent-mismatch sync, restack conflict, and post-merge multi-candidate checkout paths are wired through AI-enabled prompt choices.
- [x] Streaming reasoning preview before the recommendation - `resolveAiPromptDecision` streams text deltas under an AI reasoning preview before printing the parsed recommendation.
- [x] Confirm-or-fallback UX - Medium/high confidence recommendations ask for confirmation unless high auto-accept is configured; low/unsupported recommendations fall back to manual choices.
- [x] `dub config ai-prompts` and `ai-prompts-auto-accept` work - Config commands, normalization, CLI wiring, README docs, and tests were added.
- [x] When AI is disabled, the AI option is hidden - `aiPromptOptionsEnabled` requires `aiAssistantEnabled` and prompt mode not off; prompt choice tests verify hidden-by-default rendering.
- [x] Tests for prompt rendering, AI selection, auto-accept on high, fallback after low confidence - Added prompt builder tests and `ai-prompt-decision.test.ts` coverage for high auto-accept and low fallback.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Resolved one major prompt-safety finding before commit: invalid numeric input could have selected the appended AI option; AI menus now use safe invalid-input fallbacks and unsupported AI choices return to manual prompts.

## Dependencies

- **External blockers:** No external dependencies detected; DUB-15 and DUB-18 were already landed per issue context.

## Rollout

The feature is opt-in via the existing repo AI assistant gate and defaults to hidden because `aiAssistantEnabled` defaults false.

- **merge - Ship config and prompt support:** Users can enable AI prompt choices with `dub config ai-assistant on`; prompt mode defaults to `auto`.
- **runtime - Manual fallback remains available:** AI recommendations require confirmation unless high auto-accept is configured, and low/unsupported choices return to the manual prompt.

## Commit

```text
feat: add AI prompt decisions

Completes DUB-46
```
