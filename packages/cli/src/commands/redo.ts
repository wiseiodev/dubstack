import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  forceBranchTo,
  getCurrentBranch,
  isWorkingTreeClean,
} from '../lib/git';
import { writeState } from '../lib/state';
import {
  popRedoEntry,
  pushUndoEntryPreserveRedo,
  type UndoEntry,
  type UndoOperation,
} from '../lib/undo-log';

export interface RedoResult {
  redone: UndoOperation;
  details: string;
  warnings?: string[];
}

/**
 * Redoes the most recently undone operation by replaying the post-snapshot
 * captured at undo time. Pushes the entry back onto the undo ring so it can
 * be undone again.
 *
 * Redo restores the *state and branch tips* the original command produced.
 * It does NOT re-run the command's side effects outside of state.json + git
 * refs — most notably, `dub submit` undo restored old PR bodies, but `dub
 * redo` does NOT re-push the new bodies; re-run `dub submit` if you want
 * those back.
 */
export async function redo(cwd: string): Promise<RedoResult> {
  const entry = await popRedoEntry(cwd);
  if (!entry) {
    throw new DubError('Nothing to redo.', [
      "Run 'dub undo' first to populate the redo log.",
      'New mutating commands clear the redo stack — only undone operations can be redone.',
    ]);
  }

  const snapshot = entry.postSnapshot;
  if (!snapshot) {
    throw new DubError('Redo entry is missing its post-snapshot.', [
      'Re-run the original command manually; this redo entry is malformed.',
      "Run 'dub undo --clear' to wipe both undo and redo logs.",
    ]);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    // Put the entry back so the user can retry after stashing.
    await pushRedoEntryBack(entry, cwd);
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub redo'.",
    ]);
  }

  const warnings: string[] = [];
  const currentBranch = await getCurrentBranch(cwd);

  await writeState(snapshot.state, cwd);

  // Force every captured tip. forceBranchTo creates the branch if missing,
  // which covers redo-of-create. For redo-of-delete the deleted branches are
  // simply absent from snapshot.branchTips, so they stay deleted.
  for (const [name, sha] of Object.entries(snapshot.branchTips)) {
    try {
      await forceBranchTo(name, sha, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not reset '${name}' to ${sha}: ${message}`);
    }
  }

  const targetBranch = snapshot.branch;
  if (currentBranch !== targetBranch) {
    if (await branchExists(targetBranch, cwd)) {
      try {
        await checkoutBranch(targetBranch, cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Could not check out '${targetBranch}': ${message}`);
      }
    } else {
      warnings.push(
        `Target branch '${targetBranch}' does not exist after redo; staying on '${currentBranch}'.`,
      );
    }
  }

  // Push the original entry back onto the undo ring so it can be undone
  // again. We preserve the redo ring so the user can keep stepping
  // back/forward through their history.
  await pushUndoEntryPreserveRedo(entry, cwd);

  if (entry.operation === 'submit') {
    warnings.push(
      'PR bodies are not re-applied by `dub redo`. Re-run `dub submit` to push fresh PR bodies.',
    );
  }

  return {
    redone: entry.operation,
    details: describeRedo(
      entry.operation,
      Object.keys(snapshot.branchTips).length,
    ),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

async function pushRedoEntryBack(entry: UndoEntry, cwd: string): Promise<void> {
  const { pushRedoEntry } = await import('../lib/undo-log');
  await pushRedoEntry(entry, cwd);
}

function describeRedo(operation: UndoOperation, branchCount: number): string {
  switch (operation) {
    case 'create':
      return 'Re-created branch(es) and restored stack metadata';
    case 'rename':
      return 'Re-applied rename';
    case 'freeze':
    case 'unfreeze':
    case 'track':
    case 'untrack':
    case 'delete':
      return 'Re-applied DubStack state changes';
    case 'submit':
      return 'Restored post-submit state (PR bodies require a fresh submit)';
    default:
      return `Re-applied ${operation}: ${branchCount} branch(es)`;
  }
}
