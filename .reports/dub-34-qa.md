# Self-QA fallback - DUB-34

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub pop` is a CLI command in a Node.js stacked-diff tool. No web UI, no `.tsx`
files changed, so a browser recording would show nothing. Deterministic
shell-output evidence replaces it.

## What was verified

1. `dub pop` (no flag) soft-resets one commit, leaves its changes staged, prints
   the success message.
2. `dub pop --steps N` squashes N commits into the staging area.
3. Refuses to pop past the parent boundary with a precise error.
4. Refuses when the working tree has uncommitted changes.
5. `dub undo` after `dub pop` restores the popped commits and clears the index.
6. `dub undo` refuses when the user has switched off the popped branch.
7. `dub undo` allows untracked files (git hard-reset preserves them) but refuses
   if a tracked file has unstaged edits.
8. After `dub pop` + edit + `dub modify -ac`, descendants restack lazily onto
   the rewritten parent (cross-command test).
9. `dub pop` registered in CLI help output.

## Evidence

- 12 vitest cases under `packages/cli/src/commands/pop.test.ts` and
  `packages/cli/test/commands/pop-flow.test.ts` — all pass.
- Full repo suite green: `pnpm test` → 817 passed across 90 files.
- Quality gates: `pnpm typecheck` and `pnpm checks` pass.
- Manual E2E run against the built CLI (`node packages/cli/dist/index.js`)
  walked through pop → status → undo → status; output matched expectations
  (see commit transcript for the session log).

## Follow-up flag

None. AI-eval suite (`pnpm evals`) was skipped because no AI metadata/prompt
files changed; the suite requires provider keys not present in this workspace.
