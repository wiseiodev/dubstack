# Pattern: Git Safety

Use this pattern for changes that invoke git commands or alter stack metadata.

## Safety Rules

- Prefer non-destructive git commands by default.
- Do not rewrite history or discard work unless explicitly requested.
- Validate repository context before running mutations.

## Stack-Aware Expectations

- Preserve tracked stack invariants in `.git/dubstack/*`.
- Fail clearly when stack state is missing or invalid.
- Keep submit flow assumptions explicit (linear path requirement).

## Recovery Mindset

- Surface clear next steps when conflicts or invalid states occur.
- Keep failure modes test-covered so regressions are caught early.
- Avoid hidden side effects across branches.

## Verification

Run:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`
