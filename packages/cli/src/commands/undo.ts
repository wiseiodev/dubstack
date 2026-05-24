import { clearCleanupJournal } from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  deleteBranch,
  deleteRef,
  forceBranchTo,
  getCurrentBranch,
  isWorkingTreeClean,
  lastPushedRef,
  readLastPushedSha,
  renameBranch,
  writeLastPushedSha,
} from '../lib/git';
import { writeState } from '../lib/state';
import { clearUndoEntry, readUndoEntry } from '../lib/undo-log';

interface UndoResult {
  undone: 'create' | 'restack' | 'rename' | 'move' | 'unlink';
  details: string;
}

/**
 * Undoes the last `dub create`, `dub restack`, `dub rename`, or `dub move` operation.
 *
 * Reversal strategy:
 * - **create**: Deletes the created branch, restores state, checks out the previous branch.
 * - **restack** or **move**: Resets every rebased branch to its pre-mutation tip
 *   via `git branch -f`, restores state, checks out the previous branch.
 * - **rename**: Renames the branch back to its original name via `git branch -m`, reverses
 *   the `refs/dubstack/last-pushed/<branch>` migration, and restores state. Refuses if a
 *   branch with the original name has been re-created in the meantime. Any push that
 *   happened during the rename is NOT reverted — the local branch is restored, but the
 *   remote may still carry the renamed branch; the result message surfaces a cleanup hint.
 *
 * Only one level of undo is supported. After undo, the undo entry is cleared.
 *
 * @param cwd - Working directory
 * @returns What was undone and a human-readable summary
 * @throws {DubError} If nothing to undo or working tree is dirty
 */
export async function undo(cwd: string): Promise<UndoResult> {
  const entry = await readUndoEntry(cwd);

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub undo'.",
      'Run \'dub modify -am "<message>"\' to commit the changes first.',
    ]);
  }

  const currentBranch = await getCurrentBranch(cwd);

  if (entry.operation === 'create') {
    // If we're on a branch that's about to be deleted, switch away first
    const needsCheckout = entry.createdBranches.includes(currentBranch);
    if (needsCheckout) {
      await checkoutBranch(entry.previousBranch, cwd);
    }

    for (const branch of entry.createdBranches) {
      await deleteBranch(branch, cwd);
    }

    if (!needsCheckout && currentBranch !== entry.previousBranch) {
      await checkoutBranch(entry.previousBranch, cwd);
    }

    await writeState(entry.previousState, cwd);
    await clearUndoEntry(cwd);

    return {
      undone: 'create',
      details: `Deleted branch${entry.createdBranches.length > 1 ? 'es' : ''} '${entry.createdBranches.join("', '")}'`,
    };
  }

  if (entry.operation === 'rename') {
    const renameFrom = entry.renameFrom;
    const renameTo = entry.renameTo;
    if (!renameFrom || !renameTo) {
      throw new DubError('Undo entry is missing rename details.', [
        "Run 'rm .git/dubstack/undo.json' to clear the malformed entry.",
      ]);
    }

    if (await branchExists(renameFrom, cwd)) {
      throw new DubError(
        `Cannot undo rename: branch '${renameFrom}' already exists.`,
        [
          `Run 'git branch -D ${renameFrom}' to remove the conflicting branch, then retry 'dub undo'.`,
          `Rename the conflicting branch with 'git branch -m ${renameFrom} <other-name>', then retry.`,
        ],
      );
    }

    await renameBranch(renameTo, renameFrom, cwd);

    // Reverse the `last-pushed` ref migration done by the forward rename so
    // the next push from `renameFrom` keeps its --force-with-lease tracking.
    const trackedSha = await readLastPushedSha(renameTo, cwd);
    if (trackedSha) {
      await writeLastPushedSha(renameFrom, trackedSha, cwd);
      await deleteRef(lastPushedRef(renameTo), cwd);
    }

    await writeState(entry.previousState, cwd);

    if (currentBranch !== renameTo && currentBranch !== entry.previousBranch) {
      await checkoutBranch(entry.previousBranch, cwd);
    }

    await clearUndoEntry(cwd);

    const remoteHint = entry.hadRemote
      ? ` (remote '${renameTo}' may still exist — run 'git push origin --delete ${renameTo}' to clean up)`
      : '';
    return {
      undone: 'rename',
      details: `Renamed '${renameTo}' back to '${renameFrom}'${remoteHint}`,
    };
  }

  // restack/move undo: reset all branches to their pre-mutation tips
  // First checkout a safe branch so we don't conflict with force-moves
  await checkoutBranch(entry.previousBranch, cwd);

  for (const [name, sha] of Object.entries(entry.branchTips)) {
    if (name === entry.previousBranch) continue; // skip the branch we're on
    await forceBranchTo(name, sha, cwd);
  }

  // Now force the branch we're on (if it was tracked)
  if (entry.branchTips[entry.previousBranch]) {
    await forceBranchTo(
      entry.previousBranch,
      entry.branchTips[entry.previousBranch],
      cwd,
    );
  }

  await writeState(entry.previousState, cwd);
  if (entry.operation === 'unlink') {
    // Undoing the split must also discard any pending journaled retarget from
    // the original unlink — otherwise a subsequent `dub continue` would
    // retarget the PR for a branch that's now back in its original stack.
    await clearCleanupJournal(cwd);
  }
  await clearUndoEntry(cwd);

  const details =
    entry.operation === 'move'
      ? `Restored ${Object.keys(entry.branchTips).length} branches to pre-move state`
      : entry.operation === 'unlink'
        ? 'Restored stack metadata to pre-unlink state'
        : `Reset ${Object.keys(entry.branchTips).length} branches to pre-restack state`;

  return {
    undone: entry.operation,
    details,
  };
}
