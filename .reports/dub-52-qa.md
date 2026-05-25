# Self-QA fallback - DUB-52

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-52 changes CLI submit/config behavior, GitHub CLI wrappers, tests, and
documentation. No `.tsx` files changed and there is no browser-demoable product
surface for the new lifecycle flags.

## What was verified

- `dub submit --draft` creates new PRs through `gh pr create --draft`.
- `dub submit --publish` preflights existing PRs, promotes draft PRs through
  `gh pr ready <num>`, and errors before pushing when a selected branch has no
  open PR.
- `dub config submit-default auto|draft|publish` persists and normalizes the
  repo-local lifecycle default.
- `auto` resolves to draft when `.github/workflows/` contains workflow files
  and ready otherwise.
- Root documentation and docs app command reference describe the new flags and
  config.

## Evidence

- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed, including docs build/tests, retarget-action tests, and
  the full CLI suite.
- Earlier focused CLI test run also passed 122 test files / 1,255 tests.

## Follow-up flag

None.
