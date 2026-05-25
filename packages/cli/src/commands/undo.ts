import { clearCleanupJournal } from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  deleteBranch,
  deleteRef,
  forceBranchTo,
  getBranchTip,
  getCurrentBranch,
  hardResetBranchToRef,
  hasUnstagedTrackedChanges,
  isWorkingTreeClean,
  lastPushedRef,
  readLastPushedSha,
  renameBranch,
  writeLastPushedSha,
} from '../lib/git';
import { updatePrBody } from '../lib/github';
import { readState, writeState } from '../lib/state';
import { withTempMarkdownFile } from '../lib/temp-text-file';
import {
  clearUndoLog as clearAllUndoLogs,
  type PostSnapshot,
  popUndoEntry,
  pushRedoEntry,
  pushUndoEntryPreserveRedo,
  readUndoEntry,
  readUndoLog,
  type UndoEntry,
  type UndoOperation,
} from '../lib/undo-log';

export interface UndoResult {
  undone: UndoOperation;
  details: string;
  /** Warnings surfaced when an undo step only partially succeeded. */
  warnings?: string[];
}

export interface UndoOptions {
  /** Number of undo entries to apply in sequence (defaults to 1). */
  steps?: number;
}

/**
 * Undoes the most recent mutating operation (1 step). Pushes the entry onto
 * the redo log so `dub redo` can replay it.
 *
 * Per-operation reversal:
 * - **create**: deletes created branch(es), restores state, checks out the previous branch.
 * - **restack/move/reorder/absorb/unlink**: resets each tracked branch to its pre-mutation
 *   tip via `git branch -f`, restores state, checks out the previous branch.
 * - **rename**: renames the branch back, reverses the `refs/dubstack/last-pushed/<branch>`
 *   migration, and restores state. Push isn't reverted; the remote may still carry the
 *   renamed branch and the result message surfaces a cleanup hint.
 * - **pop**: hard-resets the popped branch to its pre-pop tip.
 * - **freeze/unfreeze**: restores `previousState` (no git refs change).
 * - **track/untrack**: restores `previousState` (no git refs change).
 * - **delete**: restores `previousState`; warns that the local git branch may need manual
 *   recreation (state knows the SHA; git branch creation is left to the user).
 * - **modify**: hard-resets the modified branch and its descendants to their pre-modify tips.
 * - **sync**: best-effort reset of every tracked branch to its pre-sync tip.
 * - **split**: restores state + branch tips.
 * - **submit**: restores the PR body for each affected PR via `gh pr edit`. PR retargeting
 *   is NOT reverted — branch base changes from submit stay in place; the result message
 *   surfaces a hint.
 */
export async function undo(
  cwd: string,
  options: UndoOptions = {},
): Promise<UndoResult> {
  const steps = options.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new DubError(`'--steps' must be a positive integer (got ${steps}).`, [
      "Pass a positive integer like '--steps 3' to undo multiple entries.",
    ]);
  }

  if (steps === 1) {
    return await undoOne(cwd);
  }

  const available = (await readUndoLog(cwd)).length;
  if (available === 0) {
    throw new DubError('Nothing to undo.', [
      'DubStack tracks the last 20 mutating operations; perform one to enable undo.',
    ]);
  }
  const toApply = Math.min(steps, available);
  const summaries: string[] = [];
  const warnings: string[] = [];
  let lastOperation: UndoOperation | null = null;
  for (let i = 0; i < toApply; i++) {
    const result = await undoOne(cwd);
    summaries.push(`${result.undone}: ${result.details}`);
    if (result.warnings) warnings.push(...result.warnings);
    lastOperation = result.undone;
  }
  return {
    undone: lastOperation ?? 'create',
    details: `Undid ${toApply} operation(s): ${summaries.join('; ')}`,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Lists the undo ring buffer, newest entry last. */
export async function listUndo(cwd: string): Promise<UndoEntry[]> {
  return await readUndoLog(cwd);
}

/** Clears the entire undo + redo ring buffers. */
export async function clearUndo(cwd: string): Promise<void> {
  await clearAllUndoLogs(cwd);
}

async function undoOne(cwd: string): Promise<UndoResult> {
  const top = await readUndoEntry(cwd);
  const postSnapshot = await capturePostSnapshot(cwd, top);

  // Pop first so a successful apply followed by a failed pop can't leave the
  // entry on the ring (which would let `dub undo` re-apply an already-undone
  // change and corrupt branch history). If apply throws, restore the entry.
  await popUndoEntry(cwd);
  let result: UndoResult;
  try {
    result = await applyUndo(cwd, top);
  } catch (error) {
    await pushUndoEntryPreserveRedo(top, cwd);
    throw error;
  }
  // Push the original entry (now decorated with its post-snapshot) onto the
  // redo ring so `dub redo` can replay it.
  await pushRedoEntry({ ...top, postSnapshot }, cwd);
  return result;
}

/**
 * Snapshots the current world (post-original-mutation) so `dub redo` can
 * replay it. Captures tips for every branch in `entry.branchTips` and every
 * branch in `entry.createdBranches` (so redo can recreate them).
 */
async function capturePostSnapshot(
  cwd: string,
  entry: UndoEntry,
): Promise<PostSnapshot> {
  const state = await readState(cwd);
  const branch = await getCurrentBranch(cwd);
  const branchTips: Record<string, string> = {};
  const relevant = new Set<string>([
    ...Object.keys(entry.branchTips),
    ...entry.createdBranches,
  ]);
  for (const name of relevant) {
    if (await branchExists(name, cwd)) {
      try {
        branchTips[name] = await getBranchTip(name, cwd);
      } catch {
        // Branch resolves but tip read fails (e.g. detached); skip.
      }
    }
  }
  return { state, branch, branchTips };
}

async function applyUndo(cwd: string, entry: UndoEntry): Promise<UndoResult> {
  if (entry.operation === 'pop') {
    return await undoPop(cwd, entry);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub undo'.",
      'Run \'dub modify -am "<message>"\' to commit the changes first.',
    ]);
  }

  const currentBranch = await getCurrentBranch(cwd);

  switch (entry.operation) {
    case 'create':
      return await undoCreate(cwd, entry, currentBranch);
    case 'rename':
      return await undoRename(cwd, entry, currentBranch);
    case 'freeze':
    case 'unfreeze':
    case 'track':
    case 'untrack':
      return await undoStateOnly(cwd, entry);
    case 'delete':
      return await undoDelete(cwd, entry);
    case 'submit':
      return await undoSubmit(cwd, entry);
    default:
      return await undoBranchReset(cwd, entry);
  }
}

async function undoPop(cwd: string, entry: UndoEntry): Promise<UndoResult> {
  const branch = entry.previousBranch;
  const sha = entry.branchTips[branch];
  if (!sha) {
    throw new DubError('Undo entry for pop is missing branch tip.', [
      "Re-run the prior 'dub pop' if you still need to roll it back.",
    ]);
  }
  const current = await getCurrentBranch(cwd);
  if (current !== branch) {
    throw new DubError(
      `Cannot undo pop: currently on '${current}', expected '${branch}'.`,
      [`Run 'dub co ${branch}' to switch back, then rerun 'dub undo'.`],
    );
  }
  if (await hasUnstagedTrackedChanges(cwd)) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub undo'.",
      'Run \'dub modify -am "<message>"\' to commit the changes first.',
    ]);
  }
  await hardResetBranchToRef(branch, sha, cwd);
  await writeState(entry.previousState, cwd);
  return {
    undone: 'pop',
    details: `Restored '${branch}' to pre-pop state`,
  };
}

async function undoCreate(
  cwd: string,
  entry: UndoEntry,
  currentBranch: string,
): Promise<UndoResult> {
  const needsCheckout = entry.createdBranches.includes(currentBranch);
  if (needsCheckout) {
    await checkoutBranch(entry.previousBranch, cwd);
  }

  for (const branch of entry.createdBranches) {
    if (await branchExists(branch, cwd)) {
      await deleteBranch(branch, cwd);
    }
  }

  if (!needsCheckout && currentBranch !== entry.previousBranch) {
    await checkoutBranch(entry.previousBranch, cwd);
  }

  await writeState(entry.previousState, cwd);

  return {
    undone: 'create',
    details: `Deleted branch${entry.createdBranches.length > 1 ? 'es' : ''} '${entry.createdBranches.join("', '")}'`,
  };
}

async function undoRename(
  cwd: string,
  entry: UndoEntry,
  currentBranch: string,
): Promise<UndoResult> {
  const renameFrom = entry.renameFrom;
  const renameTo = entry.renameTo;
  if (!renameFrom || !renameTo) {
    throw new DubError('Undo entry is missing rename details.', [
      "Run 'rm .git/dubstack/undo-log.json' to clear the malformed entry.",
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

  const trackedSha = await readLastPushedSha(renameTo, cwd);
  if (trackedSha) {
    await writeLastPushedSha(renameFrom, trackedSha, cwd);
    await deleteRef(lastPushedRef(renameTo), cwd);
  }

  await writeState(entry.previousState, cwd);

  if (currentBranch !== renameTo && currentBranch !== entry.previousBranch) {
    await checkoutBranch(entry.previousBranch, cwd);
  }

  const remoteHint = entry.hadRemote
    ? ` (remote '${renameTo}' may still exist — run 'git push origin --delete ${renameTo}' to clean up)`
    : '';
  return {
    undone: 'rename',
    details: `Renamed '${renameTo}' back to '${renameFrom}'${remoteHint}`,
  };
}

async function undoStateOnly(
  cwd: string,
  entry: UndoEntry,
): Promise<UndoResult> {
  await writeState(entry.previousState, cwd);
  return {
    undone: entry.operation,
    details: describeStateOnly(entry.operation),
  };
}

function describeStateOnly(op: UndoOperation): string {
  switch (op) {
    case 'freeze':
      return 'Restored pre-freeze frozen flags in DubStack state';
    case 'unfreeze':
      return 'Restored pre-unfreeze frozen flags in DubStack state';
    case 'track':
      return 'Restored pre-track stack metadata';
    case 'untrack':
      return 'Restored pre-untrack stack metadata';
    default:
      return 'Restored DubStack state';
  }
}

async function undoDelete(cwd: string, entry: UndoEntry): Promise<UndoResult> {
  await writeState(entry.previousState, cwd);
  const warnings: string[] = [];
  const missing: string[] = [];
  for (const branch of entry.deletedBranches ?? []) {
    if (!(await branchExists(branch, cwd))) {
      missing.push(branch);
    }
  }
  if (missing.length > 0) {
    const sha = (name: string) => entry.branchTips[name];
    const hints = missing
      .filter((name) => sha(name))
      .map((name) => `git branch ${name} ${sha(name)}`);
    if (hints.length > 0) {
      warnings.push(
        `Restored metadata only; recreate local branch${missing.length > 1 ? 'es' : ''} with: ${hints.join('; ')}`,
      );
    } else {
      warnings.push(
        `Restored metadata only; local branch${missing.length > 1 ? 'es' : ''} ${missing.map((b) => `'${b}'`).join(', ')} must be recreated manually.`,
      );
    }
  }
  return {
    undone: 'delete',
    details: `Restored ${entry.deletedBranches?.length ?? 0} branch(es) in DubStack state`,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

async function undoSubmit(cwd: string, entry: UndoEntry): Promise<UndoResult> {
  await writeState(entry.previousState, cwd);
  const warnings: string[] = [];
  const restored: number[] = [];
  for (const [prKey, body] of Object.entries(entry.prBodies ?? {})) {
    const prNumber = Number.parseInt(prKey, 10);
    if (!Number.isFinite(prNumber)) continue;
    try {
      await withTempMarkdownFile('pr-body-undo', body, async (tmpFile) => {
        await updatePrBody(prNumber, tmpFile, cwd);
      });
      restored.push(prNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to restore PR #${prNumber} body: ${message}`);
    }
  }
  warnings.push(
    'PR base/target branches are not reverted by undo. Re-run `dub submit` to re-push or `gh pr edit <pr> --base <branch>` to retarget manually.',
  );
  const summary =
    restored.length > 0
      ? `Restored PR body for ${restored.length} PR(s): ${restored.map((n) => `#${n}`).join(', ')}`
      : 'Restored DubStack state (no PR bodies to revert)';
  return {
    undone: 'submit',
    details: summary,
    warnings,
  };
}

async function undoBranchReset(
  cwd: string,
  entry: UndoEntry,
): Promise<UndoResult> {
  // restack/move/reorder/absorb/unlink/modify/sync/split — reset all tips
  await checkoutBranch(entry.previousBranch, cwd);

  const warnings: string[] = [];
  for (const [name, sha] of Object.entries(entry.branchTips)) {
    if (name === entry.previousBranch) continue;
    try {
      await forceBranchTo(name, sha, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not reset '${name}': ${message}`);
    }
  }

  if (entry.branchTips[entry.previousBranch]) {
    try {
      await forceBranchTo(
        entry.previousBranch,
        entry.branchTips[entry.previousBranch],
        cwd,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not reset '${entry.previousBranch}': ${message}`);
    }
  }

  await writeState(entry.previousState, cwd);
  if (entry.operation === 'unlink') {
    await clearCleanupJournal(cwd);
  }

  const branchCount = Object.keys(entry.branchTips).length;
  const details = describeBranchResetDetails(entry.operation, branchCount);

  return {
    undone: entry.operation,
    details,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function describeBranchResetDetails(
  operation: UndoOperation,
  branchCount: number,
): string {
  switch (operation) {
    case 'move':
      return `Restored ${branchCount} branches to pre-move state`;
    case 'reorder':
      return `Restored ${branchCount} branches to pre-reorder state`;
    case 'absorb':
      return `Reset ${branchCount} branches to pre-absorb state`;
    case 'unlink':
      return 'Restored stack metadata to pre-unlink state';
    case 'restack':
      return `Reset ${branchCount} branches to pre-restack state`;
    case 'modify':
      return `Restored ${branchCount} branch(es) to pre-modify state`;
    case 'sync':
      return `Restored ${branchCount} branch(es) to pre-sync state`;
    case 'split':
      return `Restored ${branchCount} branch(es) to pre-split state`;
    default:
      return `Reset ${branchCount} branch(es) to pre-${operation} state`;
  }
}
