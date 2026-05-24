import { DubError } from '../lib/errors';
import {
  branchExists,
  deleteRef,
  getCurrentBranch,
  isValidBranchName,
  lastPushedRef,
  pushBranch,
  readLastPushedSha,
  renameBranch,
  writeLastPushedSha,
} from '../lib/git';
import { findStackForBranch, readState, writeState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

interface RenameOptions {
  /**
   * Disable pushing the renamed branch to the remote, even when a PR exists.
   * Defaults to pushing when the tracked branch has a PR number recorded.
   */
  noPush?: boolean;
}

export interface RenameResult {
  oldName: string;
  newName: string;
  reparentedChildren: string[];
  prNumber: number | null;
  pushed: boolean;
  /** True when the old branch was previously pushed and may linger on the remote. */
  oldRemoteCleanupHint: boolean;
}

/**
 * Renames a tracked branch and propagates the change through state, child
 * `parent` references, and (when a PR exists) the remote branch.
 *
 * Argument forms:
 * - `rename(cwd, '<newName>')` — renames the current branch
 * - `rename(cwd, '<oldName>', '<newName>')` — renames a specific tracked branch
 *
 * @throws {DubError} If the rename target collides with an existing local or
 *   tracked branch, if the source branch isn't tracked, or if git rejects the
 *   rename.
 */
export async function rename(
  cwd: string,
  firstArg: string | undefined,
  secondArg?: string,
  options: RenameOptions = {},
): Promise<RenameResult> {
  if (!firstArg?.trim()) {
    throw new DubError('A new branch name is required.', [
      "Run 'dub rename <newName>' to rename the current branch.",
      "Run 'dub rename <oldName> <newName>' to rename a specific tracked branch.",
    ]);
  }

  const currentBranch = await getCurrentBranch(cwd);
  const oldName = secondArg ? firstArg.trim() : currentBranch;
  const newName = secondArg ? secondArg.trim() : firstArg.trim();

  if (!newName) {
    throw new DubError('A new branch name is required.', [
      "Run 'dub rename <newName>' to rename the current branch.",
      "Run 'dub rename <oldName> <newName>' to rename a specific tracked branch.",
    ]);
  }

  if (oldName === newName) {
    throw new DubError(`Branch '${oldName}' is already named '${newName}'.`, [
      'Pick a different name and retry.',
    ]);
  }

  if (!(await isValidBranchName(newName, cwd))) {
    throw new DubError(`Branch name '${newName}' is invalid.`, [
      'Use only ASCII letters, digits, slashes, dots, dashes, and underscores.',
      'Avoid leading dashes, double-dots, and trailing slashes; rerun with a new name.',
    ]);
  }

  const state = await readState(cwd);
  const sourceStack = findStackForBranch(state, oldName);
  if (!sourceStack) {
    throw new DubError(`Branch '${oldName}' is not tracked by DubStack.`, [
      `Run 'dub track ${oldName} --parent <branch>' to track it before renaming.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }

  const sourceBranch = sourceStack.branches.find((b) => b.name === oldName);
  if (!sourceBranch) {
    throw new DubError(
      `Branch '${oldName}' is missing from its tracked stack.`,
      ["Run 'dub doctor' to inspect the stack for metadata damage."],
    );
  }

  if (sourceBranch.type === 'root') {
    throw new DubError(`Cannot rename root branch '${oldName}'.`, [
      "Run 'dub log' to inspect the stack and pick a non-root branch.",
      `Run 'git branch -m ${oldName} <new>' manually if you must rename the root.`,
    ]);
  }

  if (findStackForBranch(state, newName)) {
    throw new DubError(`Branch '${newName}' is already tracked in a stack.`, [
      `Run 'dub untrack ${newName}' to detach it before renaming, then retry.`,
      'Pick a different new name and retry.',
    ]);
  }

  if (await branchExists(newName, cwd)) {
    throw new DubError(`Branch '${newName}' already exists locally.`, [
      `Run 'dub delete ${newName}' to remove the existing branch first.`,
      'Pick a different new name and retry.',
    ]);
  }

  const childBranches = sourceStack.branches.filter(
    (b) => b.parent === oldName,
  );
  const prNumber = sourceBranch.pr_number;
  const hadRemote = sourceBranch.last_submitted_version != null;

  await saveUndoEntry(
    {
      operation: 'rename',
      timestamp: new Date().toISOString(),
      previousBranch: currentBranch,
      previousState: structuredClone(state),
      branchTips: {},
      createdBranches: [],
      renameFrom: oldName,
      renameTo: newName,
    },
    cwd,
  );

  await renameBranch(oldName, newName, cwd);

  // Migrate the local `refs/dubstack/last-pushed/<branch>` tracking ref so
  // `pushBranch` keeps its --force-with-lease race protection after rename.
  const trackedSha = await readLastPushedSha(oldName, cwd);
  if (trackedSha) {
    await writeLastPushedSha(newName, trackedSha, cwd);
    await deleteRef(lastPushedRef(oldName), cwd);
  }

  sourceBranch.name = newName;
  const reparentedChildren: string[] = [];
  for (const child of childBranches) {
    child.parent = newName;
    reparentedChildren.push(child.name);
  }
  await writeState(state, cwd);

  let pushed = false;
  if (prNumber != null && !options.noPush) {
    await pushBranch(newName, cwd);
    pushed = true;
  }

  return {
    oldName,
    newName,
    reparentedChildren,
    prNumber,
    pushed,
    oldRemoteCleanupHint: hadRemote || pushed,
  };
}
