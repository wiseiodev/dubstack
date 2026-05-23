## TL;DR

DubStack now discovers branch checkouts in other worktrees and reports a distinct skip instead of trying to reset, rebase, or clean up those branches from the wrong worktree.

## Why

Git rejects several branch mutations when the target branch is checked out in another worktree.

Stack operations should protect collaborators and parallel workspaces by leaving those branch refs alone.

### Before

- `sync` could try to reset, rebase, or auto-clean a branch that Git had locked in another worktree.
- `restack` could attempt `git rebase --onto ... <branch>` for a branch checked out elsewhere.
- `post-merge` cleanup removed merged branches from local stack state even when the branch was active in another worktree.

### After

- `listWorktreeCheckouts(cwd)` parses `git worktree list --porcelain` and returns a branch-to-path map excluding the current worktree.
- `sync` records `checked-out-elsewhere` branch outcomes, prints the required hint, skips auto-clean deletion, and avoids reconciliation mutations for those branches.
- `restack` marks matching steps skipped before rebase execution, and `post-merge` leaves checked-out merged branches in stack state.

## File-by-file

### packages/cli/src/lib/git.ts

mod +48 / -0

Adds `listWorktreeCheckouts(cwd)` plus a shared formatter for the user-facing skip hint. The helper parses porcelain worktree output and compares real paths so macOS `/var` versus `/private/var` aliases do not cause the current worktree to be misclassified.

```ts
export async function listWorktreeCheckouts(
  cwd: string,
): Promise<Map<string, string>> {
  const repoRoot = await realpathOrResolve(await getRepoRoot(cwd));
  const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], {
    cwd,
  });
  // parse worktree/branch lines and exclude repoRoot
}
```

### packages/cli/src/commands/sync.ts

mod +25 / -0

Loads the worktree checkout map once per sync, records a distinct `checked-out-elsewhere` outcome, skips root fast-forward/restack attempts where applicable, skips auto-clean deletion, and short-circuits per-branch reconciliation before reset/rebase paths.

```ts
const outcome: BranchSyncOutcome = {
  branch,
  status: 'checked-out-elsewhere',
  action: 'skipped',
  message: formatWorktreeCheckoutSkipMessage(branch, worktreePath),
};
```

### packages/cli/src/commands/restack.ts

mod +20 / -2

Builds restack steps with worktree awareness so branches checked out elsewhere are printed and marked skipped before `rebaseOnto` can run.

```ts
status: worktreeCheckouts.has(branch.name) ? 'skipped' : 'pending'
```

### packages/cli/src/commands/post-merge.ts

mod +15 / -0

Adds `skipped` post-merge results and leaves checked-out merged branches in the stack instead of cleaning/reparenting them from another worktree.

### packages/cli/src/lib/sync/report.ts

mod +6 / -1

Extends the sync summary with a checked-out-elsewhere count when those skips occur.

### packages/cli/src/**/*.test.ts

mod +163 / -0

Adds coverage for single-worktree and two-worktree detection, sync reconciliation skip, sync auto-clean deletion skip, restack rebase skip, and post-merge cleanup skip. Updates the merge-next mock for the new post-merge result shape.

## Where to focus review

1. **Current worktree exclusion** - `packages/cli/src/lib/git.ts:50`: The helper must not report the branch checked out in the current worktree. It compares real paths to avoid macOS path alias false positives.
2. **Sync skip ordering** - `packages/cli/src/commands/sync.ts:163`: The skip is checked before cleanup deletion and before branch reconciliation so reset/rebase/delete paths never see other-worktree branches.
3. **Restack skip semantics** - `packages/cli/src/commands/restack.ts:104`: Skipped worktree steps intentionally do not update parent revisions, because this worktree did not move the protected branch.

## Test plan

- [x] **unit:** Worktree checkout discovery - packages/cli/src/lib/git.test.ts covers single worktree and a real second worktree.
- [x] **unit:** Sync checked-out-elsewhere skip - packages/cli/src/commands/sync.test.ts covers reconciliation skip and auto-clean deletion skip.
- [x] **unit:** Restack checked-out-elsewhere skip - packages/cli/src/commands/restack.test.ts verifies a real worktree branch tip is not rebased.
- [x] **unit:** Post-merge checked-out-elsewhere skip - packages/cli/src/commands/post-merge.test.ts verifies merged branch cleanup is skipped.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (Checked 199 files in 31ms. No fixes applied.)
- **Type check:** `pnpm typecheck` - passed (2 successful, 2 total. dubstack ran tsc --noEmit; docs cache hit.)
- **Full test suite:** `pnpm test` - passed (Test Files 71 passed (71); Tests 556 passed (556).)

## Self-QA

See [QA fallback evidence](.reports/dub-8-qa.md).

Self-QA fallback covering helper behavior, command skips, and required gates.

- Single worktree returns no other-worktree checkouts.
- Two real worktrees produce the expected branch-to-path map.
- Sync emits the required skip message and records `checked-out-elsewhere`.
- Restack leaves a protected branch tip unchanged.
- Post-merge leaves a checked-out merged branch in stack state.

## Acceptance criteria

- [x] `listWorktreeCheckouts` returns a map of branch to worktree path for branches checked out elsewhere - packages/cli/src/lib/git.ts plus real-worktree tests in packages/cli/src/lib/git.test.ts.
- [x] Sync skips other-worktree branches with the hint - packages/cli/src/commands/sync.ts records and prints `formatWorktreeCheckoutSkipMessage`; asserted in sync.test.ts.
- [x] Restack skips other-worktree branches - packages/cli/src/commands/restack.ts marks protected steps skipped; restack.test.ts verifies no rebase changes the branch tip.
- [x] The branch outcome in the sync summary reflects the skip with a distinct status - Branch outcome status is `checked-out-elsewhere`; summary includes `(N checked-out-elsewhere)`.
- [x] Tests: single worktree and two worktrees - packages/cli/src/lib/git.test.ts covers both cases; command tests cover behavior consumers.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Review identified one missing regression for sync auto-clean deletion; added `skips auto-clean deletion for branches checked out in another worktree` and reran targeted plus full gates.
- No remaining critical or major findings.

## Dependencies

- **External dependencies:** No external dependencies detected

## Rollout

CLI-only behavior guarded by unit and integration-style git worktree tests.

- **Before implementation - Issue and branch verified:** Linear DUB-8 was unblocked and this checkout was already on the canonical branch.
- **Implementation - Worktree-aware skips added:** Added detection in git helpers and integrated it into sync, restack, and post-merge.
- **Validation - Required gates passed:** `pnpm checks`, `pnpm typecheck`, and `pnpm test` all passed after the final staged change.

## Commit

```text
fix: skip branches checked out in other worktrees
```
