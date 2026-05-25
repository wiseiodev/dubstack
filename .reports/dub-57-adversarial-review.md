# Adversarial Review - DUB-57

## Method

- Target: staged diff for DUB-57.
- Focus: correctness, git ref consistency, restore behavior, migration timing,
  fail-soft behavior, and coverage.
- Note: external `claude --print` reviewers were attempted but failed in this
  shell with `401 Invalid authentication credentials`, so the staged diff was
  reviewed locally using the same two-perspective adversarial process.

## Findings

### Major - Fixed

`dub init --restore-from-refs` could have run the global pre-action migration
before the explicit restore action. If a stale but valid `.git/dubstack/state.json`
existed and the mirror marker was absent, that migration would overwrite
`refs/dubstack/*` from stale JSON before restore read the refs.

Fix: `packages/cli/src/index.ts` now skips automatic refs migration when the
action command is `init` with `--restore-from-refs`.

## Remaining Findings

- Critical: 0
- Major: 0
- Minor: 0
- Nitpick: 0

## Follow-up

No unresolved review findings.
