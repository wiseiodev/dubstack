# Adversarial Review - DUB-58

## Scope Reviewed

- Staged diff for multi-trunk state/config support, command wiring, docs, tests,
  and QA artifact.
- Focus areas: state migration, trunk removal safety, create/sync behavior,
  corrupt metadata handling, and backward-compatible single-trunk behavior.

## Findings

### Major - fixed

`dub trunk` lost its legacy corruption guard for stacks with no root branch.
The new `getStackTrunk()` helper intentionally falls back to `main` so callers
can render best-effort metadata, but the user-facing `dub trunk` command should
still fail loudly when old/corrupt stack metadata has neither `stack.trunk` nor
a root branch.

Resolution:

- Restored the command-level guard in `packages/cli/src/commands/trunk.ts`.
- Added a regression test in `packages/cli/src/commands/trunk.test.ts`.
- Verified the focused test with:
  `pnpm --filter dubstack exec vitest run src/commands/trunk.test.ts`.

### Critical

None remaining.

### Major

None remaining.

### Minor / Nit

No blocking minor issues. Two intentionally accepted edges:

- `dub trunk add <name>` validates git branch-name syntax but does not require a
  local branch to exist. This matches the config-first issue scope and lets teams
  register release trunks before checking them out locally.
- `dub sync --all` fetches configured trunks, including trunks without current
  stacks. That is the expected full-maintenance behavior for multi-trunk repos.

## Result

Adversarial review is clear to proceed. Critical: 0. Major: 0.
