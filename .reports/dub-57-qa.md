# Self-QA fallback - DUB-57

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-57 changes CLI state persistence, git ref mirroring, and docs. No `.tsx`
files changed and there is no browser-demoable workflow for the core behavior.

## What was verified

- `writeState` writes JSON first, mirrors branch refs and the state ref, and
  still succeeds when ref mirroring fails.
- `readState` falls back to the refs mirror when `.git/dubstack/state.json` is
  missing or corrupted.
- `dub init --restore-from-refs` rebuilds state JSON from the refs mirror.
- The one-time migration writes refs and `.git/dubstack/refs-mirror-version`.
- Stale branch refs are pruned so old mirror refs do not block later nested
  branch names.
- The new docs page builds through the docs test/build path.

## Evidence

- `pnpm --filter dubstack exec vitest run src/lib/state.test.ts src/commands/init.test.ts`
- `pnpm checks`
- `pnpm typecheck`
- `pnpm test`

## Follow-up flag

None.
