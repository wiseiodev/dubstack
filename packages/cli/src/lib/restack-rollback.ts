import { DubError } from './errors';
import { checkoutBranch, forceBranchTo, rebaseAbort } from './git';
import {
  clearRestackProgress,
  hasGitRebaseInProgress,
} from './operation-state';
import { writeState } from './state';
import { clearUndoEntry, readUndoEntry } from './undo-log';

export interface RestackRollbackResult {
  branchesRestored: number;
  previousBranch: string;
}

/**
 * Rolls a mid-conflict restack back to its pre-restack state using the
 * snapshot saved in `undo.json` + `restack-progress.json`.
 *
 * Steps:
 * 1. Abort the in-progress git rebase (if any).
 * 2. Check out the branch the user was on before the restack.
 * 3. Force every snapshotted branch back to its pre-restack tip.
 * 4. Restore the pre-restack `state.json`.
 * 5. Clear the undo entry and the restack-progress file.
 *
 * Used by the cancel-and-rollback choice in the restack conflict prompt.
 */
export async function rollbackRestack(
  cwd: string,
): Promise<RestackRollbackResult> {
  const entry = await readUndoEntry(cwd);
  if (entry.operation !== 'restack') {
    throw new DubError(
      'Cannot roll back: the most recent undo snapshot is not from a restack.',
      [
        "Run 'dub undo' to revert the last tracked operation.",
        "Run 'dub continue' to resume the in-progress restack instead.",
      ],
    );
  }

  if (await hasGitRebaseInProgress(cwd)) {
    await rebaseAbort(cwd);
  }

  await checkoutBranch(entry.previousBranch, cwd);

  for (const [name, sha] of Object.entries(entry.branchTips)) {
    if (name === entry.previousBranch) continue;
    await forceBranchTo(name, sha, cwd);
  }

  if (entry.branchTips[entry.previousBranch]) {
    await forceBranchTo(
      entry.previousBranch,
      entry.branchTips[entry.previousBranch],
      cwd,
    );
  }

  await writeState(entry.previousState, cwd);
  await clearUndoEntry(cwd);
  await clearRestackProgress(cwd);

  return {
    branchesRestored: Object.keys(entry.branchTips).length,
    previousBranch: entry.previousBranch,
  };
}
