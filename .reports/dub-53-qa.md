# Self-QA fallback - DUB-53

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-53 changes CLI submit behavior, GitHub CLI integration, MCP schema wiring,
and markdown documentation. No `.tsx` files changed and there is no browser UI
workflow to demonstrate.

## What was verified

- `dub submit --merge-when-ready` and `--method merge|squash|rebase` are wired through the CLI and `ss` alias.
- Submit queues auto-merge for every PR in scope after branch push and PR create/update.
- Submit skips PRs that already have `autoMergeRequest` queued.
- GitHub helper passes the selected method to `gh pr merge --auto`, falls back when a repository disables the preferred merge method, and wraps branch-protection / auto-merge setup failures in a `DubError` with recovery hints.
- Documentation and bundled skill references include the new submit flags.

## Evidence

- `pnpm --filter dubstack exec vitest run src/commands/submit.test.ts src/lib/github.test.ts` passed: 95 tests.
- `pnpm checks` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed: 121 CLI test files / 1236 CLI tests, docs tests, and retarget-action tests.

## Follow-up flag

No follow-up required.
