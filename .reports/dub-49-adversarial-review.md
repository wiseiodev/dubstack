# DUB-49 adversarial review

## Scope

Reviewed staged diff for the five new Evalite suites, fixture set, shared scorer
helpers, scorer determinism tests, and AI eval GitHub Actions workflow.

## Iteration 1

### Critical

None.

### Major

1. **Nightly OpenAI leg would silently run Anthropic**
   - Location: `.github/workflows/ai-evals.yml`
   - Finding: the first staged workflow exported both Anthropic and OpenAI
     secrets for every matrix row. `resolveAiProvider` prefers Anthropic before
     OpenAI when both keys are present, so the `openai` matrix leg would not have
     exercised OpenAI.
   - Resolution: patched the nightly step to export only the selected provider's
     key/model and explicitly unset the other provider key.

### Minor / nitpick

- The PR job skips when `DUBSTACK_GEMINI_API_KEY` is absent. This matches the
  repo's existing missing-secret skip pattern, and the workflow still posts a PR
  comment plus artifact log explaining the skip.
- Fixture-only split/absorb/continue suites rely on checked-in candidate
  outputs until the remaining live AI command surfaces are ready; this matches
  DUB-49's stated placeholder direction for split and absorb.

## Final

Remaining critical findings: 0.

Remaining major findings: 0.
