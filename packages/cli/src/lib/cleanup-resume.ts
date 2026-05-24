import {
  type CleanupJournal,
  type CleanupOperation,
  clearCleanupJournal,
  readCleanupJournal,
} from './cleanup-journal';
import { branchExists, deleteBranch, getCurrentBranch } from './git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrSyncInfo,
  retargetPrBase,
} from './github';
import {
  addBranchToStack,
  type Branch,
  findStackForBranch,
  readState,
  writeState,
} from './state';

export interface CleanupResumeResult {
  /** Operations that actually changed on-disk state during replay. */
  applied: CleanupOperation[];
  /** Operations that were a no-op because the change was already in place. */
  alreadyApplied: CleanupOperation[];
}

/**
 * Idempotently replay a cleanup journal.
 *
 * Each operation is reapplied independently:
 * - `delete`: deletes the local branch if it still exists; otherwise no-op.
 * - `reparent`: updates the parent in DubStack state if it doesn't already
 *   match `newParent`; otherwise no-op.
 * - `retarget`: updates the PR base via `gh pr edit` only if the current base
 *   differs from `newBase`; otherwise no-op. Skipped if the PR no longer
 *   exists.
 * - `split-track-branch`: adds the newly-created sibling branch to state
 *   when git has the branch but state hasn't recorded it yet; otherwise
 *   no-op. Skipped if the branch no longer exists in git (extractor
 *   rolled back).
 * - `split-clear-source-pr`: nulls pr_number/pr_link on the source branch
 *   when the source ended up empty and its PR was closed; otherwise no-op.
 *
 * The journal is cleared only after every operation completes without error.
 */
export async function resumeCleanup(cwd: string): Promise<CleanupResumeResult> {
  const journal = await readCleanupJournal(cwd);
  if (!journal) {
    return { applied: [], alreadyApplied: [] };
  }
  // Retarget replay hits the GitHub API. Preflight gh once up-front so the
  // user gets a clean DubError instead of a raw execa failure mid-replay.
  // Plain delete/reparent journals (e.g. those left by `dub sync`) don't need
  // gh at all, so only pay the cost when a retarget is queued.
  if (journal.operations.some((op) => op.type === 'retarget')) {
    await ensureGhInstalled();
    await checkGhAuth();
  }
  return replayJournal(cwd, journal);
}

async function replayJournal(
  cwd: string,
  journal: CleanupJournal,
): Promise<CleanupResumeResult> {
  const applied: CleanupOperation[] = [];
  const alreadyApplied: CleanupOperation[] = [];

  const state = await readState(cwd);
  const branchIndex = new Map<string, Branch>();
  for (const stack of state.stacks) {
    for (const branch of stack.branches) {
      branchIndex.set(branch.name, branch);
    }
  }

  let stateDirty = false;
  const currentBranch = await getCurrentBranch(cwd).catch(() => null);

  for (const op of journal.operations) {
    if (op.type === 'delete') {
      // Always remove the state entry first. A crash between `deleteBranch`
      // and `writeState` in the original run can leave a ghost entry pointing
      // at a now-missing branch ref — replay must clean that up regardless of
      // whether the git branch is still present.
      const stateChanged = removeBranchFromStacks(state.stacks, op.branch);
      if (stateChanged) stateDirty = true;

      if (op.branch === currentBranch) {
        // Skip deletion of the checked-out branch — git rejects -D on HEAD.
        // The state was already cleaned above; the user just needs to move
        // off this branch and re-run the interrupted cleanup command to drop
        // the branch ref itself.
        console.log(
          `⚠ Branch '${op.branch}' is currently checked out; left it in place. Switch to another branch and re-run the interrupted cleanup command (\`dub sync\`, \`dub post-merge\`, or \`dub merge-next\`) to finish removing the ref.`,
        );
        alreadyApplied.push(op);
        continue;
      }
      const exists = await branchExists(op.branch, cwd);
      if (!exists) {
        alreadyApplied.push(op);
        continue;
      }
      await deleteBranch(op.branch, cwd);
      applied.push(op);
      continue;
    }
    if (op.type === 'reparent') {
      const entry = branchIndex.get(op.branch);
      if (!entry) {
        alreadyApplied.push(op);
        continue;
      }
      if ((entry.parent ?? null) === (op.newParent ?? null)) {
        alreadyApplied.push(op);
        continue;
      }
      entry.parent = op.newParent;
      stateDirty = true;
      applied.push(op);
      continue;
    }
    if (op.type === 'split-track-branch') {
      // Skip when the branch already appears in state — the original run
      // finished the state write before crashing.
      if (branchIndex.has(op.branch)) {
        alreadyApplied.push(op);
        continue;
      }
      // Skip when the git branch is gone — the extractor rolled it back,
      // so there is nothing to track.
      const exists = await branchExists(op.branch, cwd);
      if (!exists) {
        alreadyApplied.push(op);
        continue;
      }
      addBranchToStack(state, op.branch, op.parent, op.parentTip);
      // Refresh the index so subsequent ops in the same journal see the
      // newly-tracked branch.
      const stack = findStackForBranch(state, op.branch);
      const newEntry = stack?.branches.find((b) => b.name === op.branch);
      if (newEntry) branchIndex.set(op.branch, newEntry);
      stateDirty = true;
      applied.push(op);
      continue;
    }
    if (op.type === 'split-clear-source-pr') {
      const entry = branchIndex.get(op.branch);
      if (!entry || entry.pr_number == null) {
        alreadyApplied.push(op);
        continue;
      }
      entry.pr_number = null;
      entry.pr_link = null;
      stateDirty = true;
      applied.push(op);
      continue;
    }
    // Retarget. Only OPEN PRs are retarget-able — CLOSED/MERGED PRs can't
    // change base, and NONE means the PR was deleted entirely.
    const info = await getBranchPrSyncInfo(op.branch, cwd);
    if (info.state !== 'OPEN') {
      alreadyApplied.push(op);
      continue;
    }
    if ((info.baseRefName ?? null) === op.newBase) {
      alreadyApplied.push(op);
      continue;
    }
    await retargetPrBase(op.branch, op.newBase, cwd);
    applied.push(op);
  }

  if (stateDirty) {
    await writeState(state, cwd);
  }
  await clearCleanupJournal(cwd);

  return { applied, alreadyApplied };
}

function removeBranchFromStacks(
  stacks: Array<{ branches: Branch[] }>,
  branch: string,
): boolean {
  let changed = false;
  for (const stack of stacks) {
    const deletedEntry = stack.branches.find((b) => b.name === branch);
    if (!deletedEntry) continue;
    const newParent = deletedEntry.parent;
    for (const child of stack.branches) {
      if (child.parent === branch) {
        child.parent = newParent;
        changed = true;
      }
    }
    const before = stack.branches.length;
    stack.branches = stack.branches.filter((b) => b.name !== branch);
    if (stack.branches.length !== before) changed = true;
  }
  return changed;
}
