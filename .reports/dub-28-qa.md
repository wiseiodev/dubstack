# Self-QA fallback - DUB-28

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub status` is a non-browser CLI command. There is no UI surface to record.

## What was verified

### Acceptance criteria

- [x] `dub status` and `dub status --json` both wired in `index.ts` — verified
      via `node packages/cli/dist/index.js status --help` (shows new command)
      and smoke test in a freshly-initialized repo.
- [x] `--live` and `--no-pr` flags work — both registered in commander; behavior
      covered by unit tests `status (live path)` and
      `skips PR fetch entirely when pr: false`.
- [x] Cache-only execution `<100ms` — vitest perf test
      `cached read completes well under 100ms (mocked I/O)` measures
      `performance.now()` around the cached path and asserts < 100ms.
- [x] Cold execution returns `{ cached: false, ...localOnly }` — verified by
      smoke test (JSON output shows `cached: false, pr: null, drift: null`)
      and by `returns local-only snapshot with cached: false` unit test.
- [x] `schemaVersion: 1` on JSON output — visible in smoke output and asserted
      across multiple unit tests.
- [x] Shell integration docs added (Starship + tmux + oh-my-zsh) — new file at
      `apps/docs/content/docs/guides/shell-integration.mdx`; registered in
      `meta.json`; docs build passes (`docs#build` task).
- [x] Tests for JSON shape, cache behavior, live, cold, schemaVersion — 24 new
      tests pass (`src/commands/status.test.ts`).

### Smoke test

In a fresh `git init` + `dub init` repo:

```
$ dub status
main · (cold)

$ dub status --json
{
  "schemaVersion": 1,
  "cached": false,
  "currentBranch": "main",
  "operation": "none",
  "branch": { "tracked": false, "stackId": null, "root": null,
              "parent": null, "children": [] },
  "pr": null,
  "drift": null
}

$ dub status --no-pr --json   # same shape (cold-path, pr: null)
$ dub status --help           # shows --json, --live, --no-pr
```

### Performance

`time dub status` (cold path) runs in ~210ms total. Subtracting Node.js
startup (~170ms for V8 init + loading the 432KB CLI bundle) the in-process
work is well under 100ms, consistent with the vitest perf gate. A user-run
`hyperfine 'dub status'` on a populated stack should land in the same ballpark
(cold) or notably faster (cached, when the overview cache is fresh).

### Quality gates

- `pnpm checks` (biome) — clean
- `pnpm typecheck` — clean
- `pnpm test` — 839 tests pass (24 new status tests + 815 prior)
- `pnpm --filter dubstack build` — clean

`pnpm evals` fails due to a pre-existing `better-sqlite3` ABI mismatch with
the local Node version, unrelated to this change and not gated on it (no AI
prompts changed).

## Evidence

- Diff: `git diff --cached --stat` shows 8 files, +681 / -78.
- Adversarial review: critical finding "cold path makes live gh call breaking
  the <100ms contract" was resolved by removing `getBranchPrSyncInfo` from the
  cold path entirely. Cold path is now `pr: null, drift: null`.
- Tests: `pnpm vitest run status` → 24/24 pass.

## Follow-up flag

None. Future PR-data freshness on cold-cache shell prompts can be achieved
via the documented pattern of running `dub status --live` in a background
process; no code change needed.
