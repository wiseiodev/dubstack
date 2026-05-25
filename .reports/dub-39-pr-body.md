## TL;DR

`dub reorder` adds a TUI-driven pick/drop picker for the current branch's commits. Implementation snapshots every tracked branch tip into a new `reorder` undo entry, runs `git rebase -i` via a Node `GIT_SEQUENCE_EDITOR` bridge, reuses `restackConflictPrompt`/`rollbackRestack` on conflict, and cascades a standard `restack` for descendants. Five integration tests cover the acceptance scenarios; six unit tests cover the helper and index-mapping logic. All gates pass (lint, typecheck, 940 tests).

## Why

Reordering commits is a common stack-hygiene operation today only available through raw `git rebase -i`, which lets the user pick edit/squash/reword by mistake.

DubStack already ships the shared Tier 0 conflict prompt and rollback helper; reorder should reuse them so its UX matches `dub restack` and `dub move`.

Without an undo entry, a botched reorder leaves no safety net — adding `'reorder'` to the undo log closes that gap.

### Before

- No way to reorder commits without `git rebase -i`, which exposes every rebase verb (edit/squash/reword) — many of those have dedicated commands and should not be available in the picker.
- Conflict UX during a manual `git rebase -i` was not consistent with `dub restack`'s three-option cancel/continue/exit dialog.
- Manual rebases left no undo entry, so `dub undo` could not roll back a botched reorder.

### After

- `dub reorder` opens an Inquirer-driven picker restricted to move + drop.
- Conflicts route through `restackConflictPrompt`; cancel-and-rollback reuses `rollbackRestack` via a widened operation set.
- Reorders save a `reorder` undo entry that snapshots every tracked branch tip; `dub undo` restores both the rewritten branch and any descendants the cascading restack touched.

## File-by-file

### packages/cli/src/lib/rebase-todo.ts

new +58 / -0

Builds the body of a `git rebase --interactive` todo. Pick/drop only by design — squash/edit/reword stay out of scope.

```ts
export function buildRebaseTodo(entries: readonly RebaseTodoEntry[]): string {
  if (entries.length === 0) {
    throw new DubError('Cannot build an empty rebase todo.', [...]);
  }
  const lines = entries.map((entry) => {
    const subject = entry.subject?.trim();
    const suffix = subject ? ` ${subject}` : '';
    return `${entry.action} ${entry.sha}${suffix}`;
  });
  return `${lines.join('\n')}\n`;
}
```

### packages/cli/src/commands/reorder.ts

new +618 / -0

Main command. Drives the picker, snapshots branch tips, saves a `reorder` undo entry before any rebase, invokes `git rebase -i` with a Node `GIT_SEQUENCE_EDITOR` bridge, surfaces conflicts via `restackConflictPrompt`, and cascades `restack` for descendants.

```ts
// Picker is newest-first (matches `git log`); todo is oldest-first.
// `todoIndexToDisplayIndex` is the single conversion point and is unit-tested.
//
// Conflict path: throws a DubError tagged with `kind: 'reorder-conflict'`
// so the dispatch matches on a typed discriminator, not a substring of the
// user-facing message.
```

### packages/cli/src/lib/restack-rollback.ts

mod +24 / -8

Widens the rollback gate from `operation === 'restack'` to a Set containing both `'restack'` and `'reorder'`. Lets the same rollback logic serve both commands without duplication.

```ts
const ROLLBACK_OPERATIONS = new Set(['restack', 'reorder']);

if (!ROLLBACK_OPERATIONS.has(entry.operation)) {
  throw new DubError(
    'Cannot roll back: the most recent undo snapshot is not from a restack or reorder.',
    [ ... ],
  );
}
```

### packages/cli/src/lib/undo-log.ts

mod +2 / -2

Extends `UndoEntry.operation` to include `'reorder'` and updates the 'nothing to undo' hint accordingly.

```ts
operation: 'create' | 'restack' | 'rename' | 'move' | 'reorder';
```

### packages/cli/src/commands/undo.ts

mod +8 / -6

Handles the new `reorder` operation in the same rollback code path as `restack`/`move` (reset branch tips, restore state, clear undo). Result message is reorder-specific.

```ts
const details = entry.operation === 'move'
  ? `Restored ${...} branches to pre-move state`
  : entry.operation === 'reorder'
    ? `Restored ${...} branches to pre-reorder state`
    : `Reset ${...} branches to pre-restack state`;
```

### packages/cli/src/index.ts

mod +67 / -0

Registers `dub reorder` Commander subcommand and prints status/conflict messages mirroring `dub restack` / `dub move`.

```ts
program
  .command('reorder')
  .description('Interactively reorder or drop commits within the current branch')
  .action(async () => { const result = await reorder(process.cwd()); ... });
```

### packages/cli/test/commands/reorder-tree.test.ts

new +184 / -0

Integration tests against a real git repo covering all five DUB-39 test scenarios: 3-commit reorder, drop middle, conflict-cancel rollback, undo restore, no-op exit.

### packages/cli/src/lib/rebase-todo.test.ts

new +77 / -0

Unit tests for `buildRebaseTodo` (rendering, empty-entry guard, trailing newline) and `isNoopReorder` (matches, drops, length mismatch).

### packages/cli/src/commands/reorder.test.ts

new +23 / -0

Unit tests covering the newest-first ↔ oldest-first index conversion logic that the picker relies on.

### apps/docs/content/docs/commands/reorder.mdx

new +99 / -0

User-facing docs page describing the picker UX, the deliberate pick/drop scope, conflict semantics, undo, and error table.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Inserts the new `reorder` page into the docs nav between `move` and `undo`.

## Where to focus review

1. **Newest-first display vs oldest-first rebase todo conversion** - `packages/cli/src/commands/reorder.ts (runPicker, todoIndexToDisplayIndex, isNoopReorder call site)`: The picker shows commits newest-first (matches `git log`); the on-disk todo is oldest-first. Single conversion point at `todoIndexToDisplayIndex` is unit-tested; `isNoopReorder` is called against `originalShasOldestFirst` so the comparison is apples-to-apples. Worth re-reading once.
2. **GIT_SEQUENCE_EDITOR Node bridge and shell quoting** - `packages/cli/src/commands/reorder.ts (runInteractiveRebaseWithTodo, shellQuote)`: Git invokes `GIT_SEQUENCE_EDITOR` via /bin/sh, so paths with spaces (e.g. `process.execPath` on `/Users/John Doe/…`) would split into separate tokens. `shellQuote` wraps each path in double quotes; the todo path itself travels via `DUBSTACK_REORDER_TODO` env var instead of argv to keep the command line short and safe.
3. **Conflict dispatch via typed discriminator, not message substring** - `packages/cli/src/commands/reorder.ts (isReorderConflictError, REORDER_CONFLICT_KIND)`: Restack and modify both branch on `error.message.includes('Conflict')`. Reorder instead tags the conflict DubError with `kind: 'reorder-conflict'` and inspects that property, so message edits don't silently regress the dispatch.
4. **Undo snapshot before any rebase; every tracked branch tip captured** - `packages/cli/src/commands/reorder.ts (saveUndoEntry block; double loop over state.stacks)`: Mirrors `dub move`: snapshot before mutating so a crash mid-rebase leaves rollback intact. We capture every tracked branch (not just the current stack) because the cascading restack may touch siblings rooted on the same trunk.
5. **Rollback compatibility: `rollbackRestack` widened to accept `reorder`** - `packages/cli/src/lib/restack-rollback.ts (ROLLBACK_OPERATIONS Set)`: Switching from `entry.operation !== 'restack'` to a Set keeps the existing rollback path identical for `restack` and lets `reorder` opt in. Existing rollback tests still pass; new integration test exercises the `reorder` branch.

## Test plan

- [x] **integration:** Reorder 3 commits A,B,C → C,B,A produces expected newest-first history - reorder-tree.test.ts:60-78
- [x] **integration:** Drop the middle commit; remaining commits intact and dropped file removed - reorder-tree.test.ts:80-100
- [x] **integration:** Undo restores original branch tip after a reorder - reorder-tree.test.ts:102-126
- [x] **integration:** No-op picker exit returns status 'no-op' and leaves the tip untouched - reorder-tree.test.ts:128-148
- [x] **integration:** Conflict during reorder hits restackConflictPrompt; cancel rolls back to original tip - reorder-tree.test.ts:150-184
- [x] **unit:** buildRebaseTodo + isNoopReorder - rebase-todo.test.ts (8 tests)
- [x] **unit:** Display-index ↔ todo-index mapping - reorder.test.ts (2 tests)
- [x] **manual:** CLI smoke: build, invoke reorder in a fresh temp repo, confirm picker header rendering and error paths - dub-39-qa.md (Evidence section)

## Quality gates

- **Lint + format:** `pnpm checks` - passed (Checked 306 files in 902ms. No fixes applied.)
- **Typecheck:** `pnpm typecheck` - passed (Tasks: 2 successful, 2 total (FULL TURBO cache hit))
- **Tests:** `pnpm test` - passed (Test Files 100 passed (100); Tests 940 passed (940))
- **Build:** `pnpm build (CLI)` - passed (ESM dist/index.js 491.09 KB; Build success in 31ms)
- **Evals:** `pnpm evals` - skipped (AGENTS.md §6: only required when AI metadata/prompts change; this PR changes neither. Pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch in this workspace (orthogonal).)

## Self-QA

See [QA fallback evidence](.reports/dub-39-qa.md).

QA fallback document records gate output, integration-test scenarios, and a temp-repo CLI smoke transcript.

- Reorder 3 commits — newest-first history flips correctly.
- Drop middle commit — file content removed; remaining order preserved.
- Undo — branch tip restored to exact pre-reorder SHA.
- No-op picker exit — no rebase ran; tip unchanged.
- Conflict-cancel — restackConflictPrompt + rollbackRestack route restores tip.

## Acceptance criteria

- [x] New `packages/cli/src/commands/reorder.ts` - 618 LOC, drives validation → picker → undo → rebase → conflict prompt → cascading restack.
- [x] Interactive picker - `@inquirer/select`-based loop with move/toggle-drop/finish/cancel actions.
- [x] Reorder + drop, no edit/squash - RebaseTodoEntry.action is typed `'pick' | 'drop'`; picker exposes no other verbs.
- [x] lib/rebase-todo.ts helper for building the todo string - buildRebaseTodo + isNoopReorder + RebaseTodoEntry types.
- [x] Restack descendants - `restack(cwd, { skipUndoEntry: true })` called after the rebase succeeds.
- [x] Conflict path uses existing restackConflictPrompt + rollbackRestack - defaultConflictPrompt → restackConflictPrompt; cancel branch calls rollbackRestack.
- [x] Undo log entry - saveUndoEntry({ operation: 'reorder', ..., branchTips: every-tracked-branch }) before rebase begins.
- [x] Tests for reorder, drop, conflict, undo, no-op - 5 integration tests in reorder-tree.test.ts; 8 unit tests across rebase-todo.test.ts and reorder.test.ts.
- [x] Docs at apps/docs/content/docs/commands/reorder.mdx - 99-line MDX page + nav update in meta.json.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 2/0

- Critical (resolved): Conflict detection was string-matching 'Conflict' on the DubError message. Replaced with a typed `kind: 'reorder-conflict'` discriminator and an `isReorderConflictError` helper so message edits do not regress the dispatch.
- Critical (resolved): GIT_SEQUENCE_EDITOR command line interpolated `process.execPath`, bridgeFile, and todoFile without quoting; paths with spaces (e.g. `/Users/John Doe/…/node`) would shell-split. Now each path is wrapped via a `shellQuote` helper and the todo path travels through `DUBSTACK_REORDER_TODO` env var.
- Major (resolved): undo-log 'nothing to undo' hint did not list 'reorder'. Added it so the recovery text matches the widened union.
- Minor (deferred, out of scope): MCP tool entry for `dubstack.reorder` skipped — reorder is fundamentally interactive (TUI picker) with no useful non-interactive surface. Out of DUB-39 acceptance criteria; tracked as a follow-up if AI-driven reorder use cases emerge.
- Minor (pre-existing, deferred): `rollbackRestack` does not consult `listWorktreeCheckouts` before forcing branch tips. Pre-existing behavior (same for `dub restack` rollback); not introduced by this PR. A separate fix should add worktree-aware skipping in rollback.

## Dependencies

- **DUB-81 (Tier 3 implementation guardrails):** Done — lint rules and patterns doc landed before this PR; reorder.ts follows the cheat-sheet.
- **DUB-15 (three-way reconcile conflict prompt):** Done — restackConflictPrompt + rollbackRestack reused as required by the issue.

## Rollout

Local-only CLI command. No runtime config flags, no environment variables, no remote-state changes outside ordinary git rebase semantics. Roll forward by merging the PR; roll back with a revert.

- **On merge to main - Available in `dub` CLI:** `dub reorder` becomes invocable from any DubStack-tracked branch after the next CLI publish.
- **Post-merge - User-facing docs:** Docs page renders at /commands/reorder via the Fumadocs build.
- **Rollback - Single-revert:** Revert the squash-merge commit; no schema migrations or persisted state to clean up. Existing `reorder` undo entries on disk will read as `operation: 'reorder'` and would only matter to a user who has run reorder locally — `dub undo` on the reverted CLI would error with a hint that the snapshot kind is unknown.

## Commit

```text
feat(reorder): dub reorder — interactive picker for commit reorder/drop [DUB-39]
```
