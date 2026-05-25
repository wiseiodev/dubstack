# Self-QA fallback - dub-39

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub reorder` is a terminal CLI command (no UI), driven by `@inquirer/select`
prompts. No browser is involved. The interactive picker doesn't run without a
TTY (Inquirer exits immediately), so the meaningful exercises are unit and
integration tests against the underlying flow, not a screen recording.

## What was verified

1. **All three required gates pass** (rebased onto current `origin/main`):
   - `pnpm checks` — biome lint+format, 306 files, zero errors.
   - `pnpm typecheck` — 0 type errors.
   - `pnpm test` — 940/940 tests pass (5 new integration tests + 6 new unit
     tests for this PR; no existing tests broken).
2. **Reorder integration tests cover every acceptance-criteria scenario**
   (`packages/cli/test/commands/reorder-tree.test.ts`):
   - Reorder 3 commits (A,B,C → C,B,A) — final history matches expectation.
   - Drop the middle commit — remaining commits in order without it, and the
     dropped commit's file is removed from the working tree.
   - Conflict during reorder routes through `restackConflictPrompt`; cancel
     path calls `rollbackRestack` and restores the original branch tip.
   - `dub undo` after a reorder restores the original tip (the test checks
     SHA equality, not just subject ordering).
   - No-op reorder (picker exits with no changes) returns `status: 'no-op'`
     and leaves the branch tip untouched (no rebase ran).
3. **Unit tests cover the helper and the picker mapping logic**
   (`packages/cli/src/lib/rebase-todo.test.ts`,
   `packages/cli/src/commands/reorder.test.ts`):
   - `buildRebaseTodo` renders pick/drop lines, handles missing subjects,
     refuses an empty entry list with a `DubError`, and always emits a
     trailing newline.
   - `isNoopReorder` correctly classifies reorders, drops, and length
     mismatches as non-no-ops.
   - The newest-first display ↔ oldest-first todo index mapping is
     covered for the 3-commit case.
4. **CLI smoke test** in a fresh temp repo (see commit log):
   - `dub init` + `dub create feat/x` + three commits.
   - `dub reorder --help` renders the usage block.
   - `dub reorder` invoked without a TTY exits cleanly after printing the
     picker state header (Inquirer treats no-TTY as cancel).
   - `dub reorder` invoked with a dirty worktree errors with the expected
     `DubError` and recovery hints.
5. **Adversarial self-review pass** (against the staged diff):
   - Newest-first display order vs oldest-first rebase todo: the conversion
     is in one place (`todoIndexToDisplayIndex`) and unit-tested.
   - `isNoopReorder` is called against `originalShasOldestFirst`, not the
     newest-first `commits` array (caught and fixed during the test run).
   - "Drop everything" is rejected by the picker before building a todo,
     since git aborts an empty rebase.
   - `GIT_SEQUENCE_EDITOR` uses a Node bridge script written into `tmpdir`
     rather than `cp` or shell quoting; the bridge path and todo path are
     space-free temp files and the bridge always overwrites git's todo.
   - Tier-3 lint rules (`no-bare-duberror`, `no-direct-execa-gh`,
     `no-direct-force-push`) all pass on the new code.

## Evidence

- New tests: `packages/cli/test/commands/reorder-tree.test.ts`,
  `packages/cli/src/lib/rebase-todo.test.ts`,
  `packages/cli/src/commands/reorder.test.ts`.
- Gate output: `pnpm checks` 0 errors, `pnpm typecheck` clean,
  `pnpm test` 940 passed.
- Smoke transcript (CLI built via `pnpm build`):

  ```
  Before reorder:
  C
  B
  A
  ---
  Reorder commits (newest first):
    [pick] 163c604 C
    [pick] 3d86137 B
    [pick] 2ce15c1 A
  ```

## Follow-up flag

- `pnpm evals` was not run — no AI metadata/prompts changed (AGENTS.md §6
  scopes evals to AI changes only). A pre-existing
  `better-sqlite3 NODE_MODULE_VERSION` mismatch in this workspace required a
  `pnpm rebuild better-sqlite3` to use; orthogonal to this PR.
- Conflict resume after `continue` choice: the user resolves manually, then
  `dub continue` invokes `git rebase --continue` (no reorder-progress file is
  written, so descendants are not auto-restacked). Mentioned in the docs
  page; a future PR can add a reorder-progress journal if the UX warrants
  it. DUB-39's acceptance criteria do not require it.
