# Adversarial Review - DUB-46

## Scope

Staged diff for DUB-46 after implementation, focused on sync/restack/post-merge
prompt behavior, AI recommendation safety, config persistence, and regression
coverage.

## Iteration 1

### Finding fixed before commit

- Severity: major
- Area: prompt safety
- Files: `packages/cli/src/commands/sync.ts`,
  `packages/cli/src/lib/ai-prompt-decision.ts`
- Issue: the existing numeric prompt helper returned the last choice on invalid
  input. New AI choices are appended last, so an invalid manual selection could
  accidentally invoke the AI path. Also, unsupported AI recommendation values
  should fall back to manual choices instead of throwing after the user already
  chose the AI path.
- Fix: added explicit invalid-input fallbacks for AI-extended sync menus and
  changed unsupported AI choices to return the manual fallback prompt. Added
  regression coverage for unsupported AI recommendations.

## Final Pass

- Critical findings remaining: 0
- Major findings remaining: 0
- Minor findings remaining: 0
- Nitpicks remaining: 0

## Verification After Fix

- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`
