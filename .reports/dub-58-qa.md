# Self-QA fallback - DUB-58

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-58 changes the TypeScript CLI state model, CLI command wiring, command
behavior, tests, and MDX documentation. No `.tsx` files changed, and there is no
browser-demoable UI surface for the behavior.

## What was verified

- Legacy single-trunk state normalizes to configured `trunks`, `defaultTrunk`,
  and per-stack `trunk` fields.
- `dub trunk`, `dub trunk list`, `dub trunk add`, `dub trunk remove`, and
  `dub trunk set-default` are covered by unit tests.
- `dub create` uses `defaultTrunk` from untracked branches and preserves the
  current stack trunk from tracked branches.
- `dub sync` scopes plain sync to the current stack trunk and `--all` to every
  configured trunk plus every stack branch.
- `dub doctor` reports stacks rooted at unconfigured trunks.
- The docs build includes the new multi-trunk guide.

## Evidence

- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed: 123 CLI test files, 1353 CLI tests, docs tests, and
  retarget-action tests.

## Follow-up flag

No follow-up required from QA.
