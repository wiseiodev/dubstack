import { DubError } from './errors';
import {
  formatWorktreeCheckoutSkipMessage,
  getCurrentBranch,
  listWorktreeCheckouts,
} from './git';
import { getAncestors, getDescendants } from './graph';
import {
  type Branch,
  findStackForBranch,
  readState,
  type Stack,
  topologicalOrder,
  writeState,
} from './state';
import { saveUndoEntry } from './undo-log';

interface FreezeOptions {
  branch?: string;
  upstack?: boolean;
  downstack?: boolean;
}

export interface FreezeResult {
  /** Tracked branches whose `frozen` flag was changed by this invocation. */
  changed: string[];
  /** Tracked branches already in the target state — no change needed. */
  unchanged: string[];
  /** Tracked branches skipped because they are checked out in another worktree. */
  skipped: Array<{ branch: string; worktree: string }>;
}

interface ApplyFreezeOptions {
  cwd: string;
  options: FreezeOptions;
  frozen: boolean;
  /** Label used when logging worktree skips (e.g. `dub freeze`). */
  commandLabel: string;
  /** Undo operation label saved to `.git/dubstack/undo.json`. */
  undoOperation: 'freeze' | 'unfreeze';
}

/**
 * Shared implementation for `dub freeze` and `dub unfreeze`. Resolves the
 * scope (single branch + optional ancestor / descendant cascade), persists an
 * undo entry, skips branches checked out in another worktree, and writes the
 * updated state.
 *
 * @throws {DubError} If the target branch is unknown, is the root, or `--upstack` and `--downstack` are both set.
 */
export async function applyFreezeFlag(
  applyOptions: ApplyFreezeOptions,
): Promise<FreezeResult> {
  const { cwd, options, frozen, commandLabel, undoOperation } = applyOptions;

  if (options.upstack && options.downstack) {
    throw new DubError("'--upstack' and '--downstack' cannot be combined.", [
      `Run 'dub ${undoOperation} <branch> --upstack' to cascade through descendants.`,
      `Run 'dub ${undoOperation} <branch> --downstack' to cascade through ancestors.`,
    ]);
  }

  const currentBranch = await getCurrentBranch(cwd);
  const branchName = options.branch ?? currentBranch;
  const state = await readState(cwd);
  const stack = findStackForBranch(state, branchName);
  if (!stack) {
    throw new DubError(`Branch '${branchName}' is not tracked by DubStack.`, [
      `Run 'dub track ${branchName} --parent <branch>' to track it first.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }

  const target = stack.branches.find((b) => b.name === branchName);
  if (!target) {
    throw new DubError(
      `Branch '${branchName}' is missing from its tracked stack.`,
      ["Run 'dub doctor' to inspect the stack for metadata damage."],
    );
  }
  if (target.type === 'root') {
    throw new DubError(`Cannot ${undoOperation} root branch '${branchName}'.`, [
      `Run 'dub log' to inspect the stack and pick a non-root branch.`,
      `Run 'dub ${undoOperation} <branch>' on a tracked child of '${branchName}'.`,
    ]);
  }

  const targets = collectFreezeTargets(stack, target.name, options);

  const worktreeCheckouts = await listWorktreeCheckouts(cwd);
  const safeBranches: Branch[] = [];
  const skipped: Array<{ branch: string; worktree: string }> = [];
  for (const branch of targets) {
    const worktree = worktreeCheckouts.get(branch.name);
    if (worktree) {
      console.log(
        formatWorktreeCheckoutSkipMessage(branch.name, worktree, commandLabel),
      );
      skipped.push({ branch: branch.name, worktree });
      continue;
    }
    safeBranches.push(branch);
  }

  const changedBranches: Branch[] = [];
  const unchanged: string[] = [];
  for (const branch of safeBranches) {
    if (Boolean(branch.frozen) === frozen) {
      unchanged.push(branch.name);
    } else {
      changedBranches.push(branch);
    }
  }

  if (changedBranches.length === 0) {
    return { changed: [], unchanged, skipped };
  }

  await saveUndoEntry(
    {
      operation: undoOperation,
      timestamp: new Date().toISOString(),
      previousBranch: currentBranch,
      previousState: structuredClone(state),
      branchTips: {},
      createdBranches: [],
    },
    cwd,
  );

  for (const branch of changedBranches) {
    if (frozen) {
      branch.frozen = true;
    } else {
      // Delete the field rather than store `false` so existing JSON stays clean.
      delete branch.frozen;
    }
  }

  await writeState(state, cwd);

  return {
    changed: changedBranches.map((b) => b.name),
    unchanged,
    skipped,
  };
}

function collectFreezeTargets(
  stack: Stack,
  branchName: string,
  options: FreezeOptions,
): Branch[] {
  const branchMap = new Map(stack.branches.map((b) => [b.name, b]));
  const selected = new Set<string>([branchName]);

  if (options.downstack) {
    for (const ancestor of getAncestors(stack, branchName)) {
      if (branchMap.get(ancestor)?.type === 'root') continue;
      selected.add(ancestor);
    }
  }
  if (options.upstack) {
    for (const descendant of getDescendants(stack, branchName)) {
      selected.add(descendant);
    }
  }

  // Emit in topological (root → leaf) order so cascade output is consistent
  // across `--upstack` and `--downstack`.
  return topologicalOrder(stack).filter(
    (branch) => branch.type !== 'root' && selected.has(branch.name),
  );
}
