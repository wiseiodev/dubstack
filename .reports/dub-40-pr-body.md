## TL;DR

New `dub unlink <branch>` command splits a tracked branch (and optionally its descendants) into its own stack without touching any local git branches; retargets the open PR to the original trunk via a journaled `gh pr edit` so a crash is resumable with `dub continue`.

## Why

DubStack had no first-class way to break a parent edge in state without deleting the branch or its descendants.

Tier 3 power-command gap: users had to manually edit `.git/dubstack/state.json` to split a stack.

Builds on Tier 0/1 infrastructure (DubError, cleanup journal, undo log) so it inherits crash-safety and recovery uniformly.

### Before

- No `unlink.ts` command existed.
- Splitting a stack required hand-editing JSON or untracking + retracking, both of which lose PR linkage.

### After

- `dub unlink <branch>` detaches the branch in state; new stack rooted at `<branch>` with `type: 'root'`, `parent: null`, `parent_revision` cleared.
- `--keep-children` (default) moves descendants with `<branch>`; `--orphan-children` leaves them on the original parent.
- `--no-retarget` opts out of the `gh pr edit` and prints the manual command.
- Open PR is retargeted to the original trunk, with the retarget op journaled so `dub continue` resumes a crash mid-`gh pr edit`.
- `dub undo` rolls the split back and discards the pending cleanup journal to keep the two recovery paths consistent.
- Exposed as an MCP tool (`dubstack.unlink`).

## File-by-file

### packages/cli/src/commands/unlink.ts

new +257 / -0

Core command: validates inputs, plans the PR retarget against the original trunk, opens a cleanup journal recording only the retarget op (the state split itself is a single atomic writeState), mutates state, persists an `unlink` undo entry, runs `retargetPrBase` if not skipped, then clears the journal.

```ts
const journal = await startCleanupJournal(cwd);
if (plannedRetarget) {
  await appendCleanupOperation(cwd, journal, {
    type: 'retarget',
    branch: plannedRetarget.branch,
    newBase: plannedRetarget.newBase,
  });
}
// ...state mutation...
await writeState(state, cwd);
await saveUndoEntry({ operation: 'unlink', ... }, cwd);
if (plannedRetarget) {
  await retargetPrBase(plannedRetarget.branch, plannedRetarget.newBase, cwd);
}
await clearCleanupJournal(cwd);
```

### packages/cli/src/index.ts

mod +89 / -0

Registers the `dub unlink` Commander command. Validates `--keep-children` and `--orphan-children` are mutually exclusive at the CLI layer, surfaces a yellow warning + manual `gh pr edit` hint when `--no-retarget` skipped a PR retarget.

### packages/cli/src/commands/mcp.ts

mod +44 / -0

Adds the `dubstack.unlink` tool to the MCP surface (mutating: true) with input schema and a handler that delegates to `unlink(cwd, ...)`. Also adds the field to `HISTORY_ARG_KEYS` so MCP tool invocations show up in `dub history`.

### packages/cli/src/commands/undo.ts

mod +5 / -1

Extends undo handling to `unlink`. Reuses the restack/move force-restore loop (no-op for unlink since `branchTips` is empty) and additionally clears any pending cleanup journal so a stale retarget op can't fire on a branch that's been moved back to its original stack.

```ts
if (entry.operation === 'unlink') {
  // Undoing the split must also discard any pending journaled retarget
  // from the original unlink — otherwise `dub continue` would retarget
  // a branch that's now back in its original stack.
  await clearCleanupJournal(cwd);
}
```

### packages/cli/src/lib/undo-log.ts

mod +1 / -1

Adds `'unlink'` to the `UndoEntry.operation` discriminator so the new operation is type-safe end to end.

### packages/cli/src/commands/unlink.test.ts

new +362 / -0

10 unit tests covering: mid-stack unlink with PR retarget, leaf unlink, --orphan-children, --no-retarget with and without a PR, journal-stays-on-disk on retarget failure, root rejection, untracked rejection, dirty worktree rejection, PR-already-on-trunk no-op.

### packages/cli/test/commands/unlink-resume.test.ts

new +130 / -0

Integration test that exercises a real cleanup journal on disk: forces `retargetPrBase` to throw, asserts the state split persisted and the journal contains the retarget op, then calls `resumeCleanup` and confirms the retarget runs and the journal is cleared.

### packages/cli/src/commands/undo.test.ts

mod +43 / -1

Regression test for the undo-clears-journal behavior: seeds an `unlink` undo entry plus a journal with a pending retarget op, runs `dub undo`, and asserts the journal is gone afterward.

### packages/cli/src/commands/mcp.test.ts

mod +1 / -0

Updates the canonical `tools/list` expectation to include `dubstack.unlink`.

### apps/docs/content/docs/commands/unlink.mdx

new +101 / -0

Public docs: usage, flags, before/after tree diagrams for default and --orphan-children, crash-safety semantics, error table, related commands.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Adds `unlink` to the docs sidebar between `move` and `undo`.

## Where to focus review

1. **Crash safety of journal + writeState + retarget ordering** - `packages/cli/src/commands/unlink.ts:160-235`: Mirrors the `move.ts` pattern: journal opened before writeState, undo entry saved before the retarget runs, journal cleared only on success. The retarget op alone is journaled — the state split itself is atomic via a single writeState. Trace each crash window to confirm `dub continue` can recover.
2. **Promotion to a new root invariants** - `packages/cli/src/commands/unlink.ts:190-203`: When `<branch>` becomes a root we set `type: 'root'`, `parent: null`, and explicitly clear `parent_revision`. `assertStateInvariants` runs immediately after. Confirm this matches DubStack's root semantics and that downstream callers (restack, log, doctor) handle a non-trunk-named root.
3. **Undo + journal coexistence** - `packages/cli/src/commands/undo.ts:144-150`: The undo path for `unlink` explicitly clears the cleanup journal. This is a tighter pattern than `move` uses (where the journal can survive an undo). Confirm this is the desired behavior — the same change could be applied to `move` in a follow-up but is deliberately out of scope here.
4. **PR retarget target** - `packages/cli/src/commands/unlink.ts:125-156`: We retarget to the original stack's root (`type: 'root'` branch). This matches `dub trunk`'s own definition of trunk. If a stack's root is itself a sub-branch (rare), the PR will end up based on that sub-branch rather than the git default branch. Spec-compliant per DUB-40 but worth double-checking.

## Test plan

- [x] **unit:** unlink command — 10 cases covering all flags + error paths - packages/cli/src/commands/unlink.test.ts (pnpm test)
- [x] **integration:** Crash mid-retarget → resumeCleanup replays the journal - packages/cli/test/commands/unlink-resume.test.ts (pnpm test)
- [x] **integration:** dub undo discards pending cleanup journal for unlink - packages/cli/src/commands/undo.test.ts (pnpm test)
- [x] **manual:** Sandbox end-to-end (default, --orphan-children, undo, root rejection, mutex flag guard) - .reports/dub-40-qa.md

## Quality gates

- **lint + format:** `pnpm checks` - passed (Checked 302 files in 629ms. No errors.)
- **typecheck:** `pnpm typecheck` - passed (dubstack + docs both clean (tsc --noEmit))
- **unit + integration tests:** `pnpm test` - passed (926 tests passed across 99 test files (up from 924 baseline))

## Self-QA

See [QA fallback evidence](.reports/dub-40-qa.md).

Sandbox transcript: default unlink, undo, --orphan-children, root rejection, --keep-children + --orphan-children mutex guard.

- Default `dub unlink feat/auth-login` on main→feat/auth-base→feat/auth-login→feat/auth-mfa: split into two stacks with feat/auth-login as new root.
- `dub undo`: restored pre-unlink shape exactly.
- `dub unlink feat/auth-login --orphan-children`: direct child re-parented onto feat/auth-base; new stack contains only feat/auth-login.
- `dub unlink main`: rejected with DubError + recovery hint.
- `dub unlink ... --keep-children --orphan-children`: rejected at CLI layer with DubError + recovery hint.

## Acceptance criteria

- [x] New `packages/cli/src/commands/unlink.ts` - File created, 257 lines.
- [x] State split into two stacks - Unit test 'promotes a mid-stack branch to a new root' + sandbox state.json inspection.
- [x] PR retargeting (or skip with warning per flag), journaled via `CleanupRetargetOp` - Retarget unit test asserts the appendCleanupOperation call with a retarget op + the resume integration test.
- [x] `--keep-children` and `--orphan-children` flags work - --orphan-children unit test + sandbox transcript; default keep-children covered by mid-stack test.
- [x] Undo log entry - saveUndoEntry called with operation: 'unlink'; sandbox `dub undo` round-trip; undo.test.ts journal-clearing test.
- [x] Tests for each path + crash-resume - 10 unit tests in unlink.test.ts + integration test unlink-resume.test.ts.
- [x] Docs at `apps/docs/content/docs/commands/unlink.mdx` - File created; meta.json updated to list it in the sidebar.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Reviewer raised concern about undo+journal coexistence (Finding 1). Addressed by clearing the cleanup journal as part of undo for `unlink` and added a regression test.
- Reviewer raised concern about trunk resolution potentially picking a non-git-trunk root (Finding 2). Confirmed this matches DubStack's own `dub trunk` definition (the stack root) — no change needed.
- Reviewer flagged a missing test for --no-retarget on a branch with no PR (Finding 4). Added the test.

## Dependencies

- **DUB-81 (Tier 3 implementation guardrails):** Done — used the patterns doc, biome plugin rules pass.
- **DUB-76 (Post-merge journal unification, exposes CleanupRetargetOp):** Done — reused `CleanupRetargetOp` and `resumeCleanup` unchanged.

## Rollout

Pure additive feature behind a new subcommand. No flag/gate; safe to merge after review.

- **On merge - Ship:** Build pipeline picks up `dub unlink` automatically — no migration, no config change.
- **Post-merge - Docs deploy:** apps/docs build will surface the new `/docs/commands/unlink` page in the sidebar.

## Commit

```text
feat(unlink): detach branch from parent into its own stack [DUB-40]
```
