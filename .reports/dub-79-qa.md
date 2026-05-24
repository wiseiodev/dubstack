# Self-QA fallback - DUB-79

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub submit` is a Node CLI; the change affects the `detail` text shown in the
TTY progress bar (`🚀 Pushing branches` / `📬 Syncing PRs`). No `.tsx` file
or browser surface was modified. The output is fully deterministic for a given
stack shape and is covered by unit tests.

## What was verified

- New helper `createSubTreeTagger` derives a sub-tree tag for each branch from
  the in-memory `Stack` and trunk name. The tag is the deepest ancestor with at
  least one sibling.
- Progress label format:
  - Tree stack with a sub-tree: `feat/auth-base · feat/auth-login` (matches the
    issue's worked example).
  - Branch directly on trunk: `feat/auth-base` (no `·` prefix).
  - Linear stack (no fork anywhere): just the branch name (no breaking `·`).
- `submit.ts` push loop and PR-sync loop both feed the tagger output into
  `progress.update(..., detail)`.
- Acceptance criteria mapping:
  - [x] Progress update lines show sub-tree context on tree-shaped stacks
        — covered by `prefixes descendants with the deepest ancestor that has
        siblings` and `uses the deepest forked ancestor, not the trunk-child`.
  - [x] Linear stacks render unchanged (no breaking `·`) — covered by
        `returns the branch name unchanged in a linear stack` and
        `does not prefix branches that sit directly on trunk`.
  - [x] Snapshot tests for the update label format in linear and tree
        scenarios — six equality assertions in
        `packages/cli/test/commands/submit-progress.test.ts`.

## Evidence

- Unit tests: `packages/cli/test/commands/submit-progress.test.ts` (6 cases,
  all passing).
- Full suite: `pnpm test` — 86 test files, 767 tests, all passing.
- Lint/format: `pnpm checks` — clean.
- Types: `pnpm typecheck` — clean.

## Follow-up flag

None. Behavior is additive (label text only); no state-shape or scope-flag
changes.
