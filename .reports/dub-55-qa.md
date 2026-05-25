# Self-QA fallback - DUB-55

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-55 changes the TypeScript CLI submit path, GitHub CLI helper behavior, and
Markdown docs. No committed `.tsx` files changed, and there is no browser UI
surface to record for the behavior.

## What was verified

- `dub submit` accepts `--rerequest-review` and `--rerequest-review-only`.
- Updated PRs re-request review from pending and prior reviewers.
- `--rerequest-review-only` filters the reviewer set.
- Newly created PRs do not attempt reviewer re-requesting.
- GitHub permission failures surface as actionable `DubError` messages.
- README and docs command reference describe the new flags.

## Evidence

- `pnpm exec vitest run src/commands/submit.test.ts src/lib/github.test.ts`
- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`

## Follow-up flag

None.
