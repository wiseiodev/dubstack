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
import { type Branch, readState, writeState } from './state';

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
