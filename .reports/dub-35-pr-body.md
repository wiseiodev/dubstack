## TL;DR

New `dub rename <new>` (or `dub rename <old> <new>`) command. Renames the branch in git, updates DubStack state and children's parent links, migrates the local `last-pushed` lease ref, pushes the new branch when a PR is linked, and records a single-level undo entry. `dub undo` reverses the rename in full (branch name, state, parent links, lease ref).

## Why

Users frequently want to rename a stacked branch as the work clarifies (e.g. `feat/auth-spike` → `feat/auth-login`).

Doing this by hand requires `git branch -m`, manually editing `.git/dubstack/state.json`, fixing every child's `parent`, and rePushing — easy to leave state out of sync.

### Before

- No `dub rename` command. Users had to `git branch -m` plus hand-edit `state.json` plus manually re-parent children.
- After a rename, `refs/dubstack/last-pushed/<branch>` was orphaned, which would have caused the next push to fall back to a bare `--force-with-lease` (losing race protection).

### After

- `dub rename <new>` (or `dub rename <old> <new>`) updates branch name, state, children, and lease ref atomically.
- When a PR is linked, the renamed branch is pushed automatically (skippable via `--no-push`).
- `dub undo` rolls back the entire operation — name, state, parent links, lease ref — except the remote push itself.

## File-by-file

### packages/cli/src/commands/rename.ts

new +173 / -0

The new command. Validates arguments and collisions (tracked, untracked-local, root branch, invalid ref, self-rename), saves a single undo entry before any mutation, runs `git branch -m`, migrates `refs/dubstack/last-pushed/<branch>`, updates branch.name + every child's parent in state, then pushes when a PR is linked.

```typescript
await renameBranch(oldName, newName, cwd);

const trackedSha = await readLastPushedSha(oldName, cwd);
if (trackedSha) {
  await writeLastPushedSha(newName, trackedSha, cwd);
  await deleteRef(lastPushedRef(oldName), cwd);
}

sourceBranch.name = newName;
for (const child of childBranches) {
  child.parent = newName;
  reparentedChildren.push(child.name);
}
await writeState(state, cwd);
```

### packages/cli/src/commands/undo.ts

mod +50 / -1

Extends the existing one-level undo machinery to handle the new 'rename' operation. Reverses the git rename, restores the previous state, and reverses the lease-ref migration. Refuses to clobber a pre-existing branch named `renameFrom`.

```typescript
if (await branchExists(renameFrom, cwd)) {
  throw new DubError(
    `Cannot undo rename: branch '${renameFrom}' already exists.`,
    [...]
  );
}

await renameBranch(renameTo, renameFrom, cwd);

const trackedSha = await readLastPushedSha(renameTo, cwd);
if (trackedSha) {
  await writeLastPushedSha(renameFrom, trackedSha, cwd);
  await deleteRef(lastPushedRef(renameTo), cwd);
}
```

### packages/cli/src/lib/git.ts

mod +26 / -0

Adds a small `renameBranch(old, new, cwd)` helper that wraps `git branch -m` with DubError + recovery hints. Works for both currently-checked-out and not-checked-out branches.

```typescript
export async function renameBranch(
  oldName: string,
  newName: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['branch', '-m', oldName, newName], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to rename branch '${oldName}' to '${newName}'.`,
        readGitCommandOutput(error),
      ),
      [...]
    );
  }
}
```

### packages/cli/src/lib/undo-log.ts

mod +5 / -1

Extends UndoEntry.operation to include 'rename' and adds optional `renameFrom`/`renameTo` fields. Backwards-compatible because existing 'create'/'restack' entries leave the new fields undefined.

```typescript
operation: 'create' | 'restack' | 'rename';
// ...
/** For `rename`: the original branch name before the rename. */
renameFrom?: string;
/** For `rename`: the new branch name after the rename. */
renameTo?: string;
```

### packages/cli/src/index.ts

mod +54 / -1

Wires `dub rename` into the Commander program. Accepts `<firstName> [secondName]` plus a `--no-push` flag. Emits a green success line, a re-parent summary if children were touched, and a cleanup hint when the old remote branch may linger.

```typescript
program
  .command('rename')
  .argument('<firstName>', 'New name (current branch) or old name')
  .argument('[secondName]', 'New name when renaming a specific tracked branch')
  .option('--no-push', 'Skip pushing the renamed branch even if a PR exists')
```

### packages/cli/src/commands/rename.test.ts

new +247 / -0

16 integration tests covering rename + collision + undo + lease-ref migration. Uses the repo's `createTestRepo()` helper so each test runs against a real isolated git repo.

### apps/docs/content/docs/commands/rename.mdx

new +61 / -0

Public docs page describing usage, behavior, flags, error conditions, and undo semantics.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Adds `rename` to the Commands nav after `track`.

## Where to focus review

1. **Lease-ref migration on rename + undo** - `packages/cli/src/commands/rename.ts and undo.ts`: The `refs/dubstack/last-pushed/<branch>` ref protects future pushes from racing third parties. Forgetting to migrate it on rename would silently downgrade the next push to a bare `--force-with-lease`. Worth confirming both the forward migration and the undo reversal cover the edge case where the branch was never previously submitted (no ref to migrate).
2. **PR head handling vs. issue spec step 5** - `packages/cli/src/commands/rename.ts (no `gh pr edit --head` call)`: The issue spec mentions `gh pr edit <num> --head <new>`, but the gh CLI does NOT support `--head` on `pr edit` and the GitHub REST API does not allow editing a PR's head ref. The implementation pushes the renamed branch and surfaces a cleanup hint instead — the old remote branch is intentionally left alone so the existing PR stays valid. Confirm this is acceptable trade-off.
3. **Undo refuses to clobber an existing `renameFrom` branch** - `packages/cli/src/commands/undo.ts`: If a user renamed `feat/old → feat/new` and then independently created a new `feat/old`, `dub undo` must not silently overwrite that branch. We throw a DubError with recovery hints instead. Worth a second look at the failure message.

## Test plan

- [x] **integration:** 16 rename tests in packages/cli/src/commands/rename.test.ts - Covers basic rename, two-arg rename, child re-parent, all 5 error paths, undo round-trip, last-pushed migration round-trip, PR-aware push, --no-push.
- [x] **integration:** Undo tests in packages/cli/src/commands/undo.test.ts - Existing create/restack undo tests still pass after extending UndoEntry.
- [x] **unit:** Full repo suite (819 tests across 89 files) - pnpm test passes end-to-end.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (Checked 269 files in 56ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (2 packages, no errors.)
- **Vitest (full suite):** `pnpm test` - passed (89 test files, 819 tests passing.)

## Self-QA

See [QA fallback evidence](.reports/dub-35-qa.md).

Fallback QA covering 15 behavioral scenarios via integration tests against real git repos.

- Rename current branch
- Rename specific branch (old + new args) from another branch
- Re-parent children
- Reject tracked-name collision
- Reject untracked-local-name collision
- Reject invalid git ref name
- Reject untracked source
- Reject root-branch rename
- Reject self-rename
- Save undo entry with operation='rename' + renameFrom/renameTo
- Undo restores name + state + child parents
- last-pushed ref migrates on rename
- last-pushed ref restored on undo
- Push triggered when PR linked; skipped otherwise
- --no-push skips push even with PR

## Acceptance criteria

- [x] New packages/cli/src/commands/rename.ts - Created with full implementation (173 lines).
- [x] Validation, git branch rename, state update, child re-parenting, PR edit, push - All steps implemented. Note: gh CLI / GitHub API do not allow editing PR head — substituted with push of renamed branch + cleanup hint for the old remote.
- [x] Undo log entry - UndoEntry extended with 'rename' operation; saveUndoEntry called before mutations.
- [x] Tests for rename, collision, undo - 16 tests in rename.test.ts including all 3 explicit collision/undo cases plus 13 more.
- [x] Docs at apps/docs/content/docs/commands/rename.mdx - Created with usage, flags, error table, undo semantics. Added to commands meta.json nav.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Resolved: forward rename now migrates refs/dubstack/last-pushed/<old> to <new>; undo reverses it.
- Resolved: removed noisy 'No PR linked — nothing to push' line that fired on every rename without a PR.
- Reviewer initially flagged an undo checkout ordering issue but self-dismissed it after tracing git's `branch -m` HEAD update semantics.

## Dependencies

- **No external dependencies detected:** n/a

## Rollout

Ship as a new CLI command in the next release. No flags or migrations. Existing undo entries remain valid because the new fields are optional.

- **Merge - Standard squash merge to main:** Conventional commit `feat(rename): ...` so semantic-release picks it up.
- **Post-release - Verify in real repo:** Run `dub rename` on a sandbox repo with a linked PR to confirm push + cleanup hint behave as documented.

## Commit

```text
feat(rename): add dub rename command [DUB-35]
```
