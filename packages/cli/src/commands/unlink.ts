import * as crypto from 'node:crypto';
import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import { getCurrentBranch, isWorkingTreeClean } from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import { getDescendants } from '../lib/graph';
import { assertStateInvariants } from '../lib/invariants';
import {
  findStackForBranch,
  readState,
  type Stack,
  writeState,
} from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

export interface UnlinkOptions {
  /** Skip PR retargeting; print a warning that the PR base is now out of sync. */
  noRetarget?: boolean;
  /**
   * Re-parent direct children onto `<branch>`'s old parent (they stay in the
   * original stack) instead of moving them with `<branch>` into the new stack.
   */
  orphanChildren?: boolean;
}

export interface UnlinkResult {
  /** Branch detached. */
  branch: string;
  /** Branch's parent before unlink. */
  previousParent: string;
  /** ID of the new stack `<branch>` was promoted into. */
  newStackId: string;
  /** Original trunk PR was retargeted to (or would have been). */
  trunk: string;
  /** Descendants that followed `<branch>` into the new stack. */
  movedDescendants: string[];
  /** Direct children re-parented onto the original parent (orphan-children). */
  orphanedChildren: string[];
  /** True when an open PR was actually retargeted. */
  retargeted: boolean;
  /** PR number when retargeting happened or was skipped via `--no-retarget`. */
  prNumber?: number;
  /** True when `--no-retarget` short-circuited a PR retarget; surface a warning. */
  retargetSkipped: boolean;
}

/**
 * Removes the parent edge for `<branch>` and promotes it to the root of a new
 * stack without touching local git branches.
 *
 * Workflow:
 * 1. Validate `<branch>` is tracked and non-root with a clean worktree.
 * 2. Plan a PR retarget to the original trunk if the branch has an open PR.
 * 3. Open a cleanup journal recording the retarget so `dub continue` can
 *    resume a crash mid-`gh pr edit`.
 * 4. Apply the state split atomically (single `writeState`) — branch becomes
 *    a new root, descendants follow (default) or are orphaned onto the old
 *    parent (`--orphan-children`).
 * 5. Persist an `unlink` undo entry so `dub undo` rolls the split back.
 * 6. Perform the PR retarget (unless `--no-retarget`), then clear the journal.
 */
export async function unlink(
  cwd: string,
  branch: string,
  options: UnlinkOptions = {},
): Promise<UnlinkResult> {
  if (!branch || branch.trim().length === 0) {
    throw new DubError("Pass a branch name to 'dub unlink'.", [
      "Run 'dub unlink <branch>' to detach <branch> into its own stack.",
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub unlink'.",
      'Run \'dub modify -am "<message>"\' to commit the changes first.',
    ]);
  }

  const state = await readState(cwd);
  const stack = findStackForBranch(state, branch);
  if (!stack) {
    throw new DubError(`Branch '${branch}' is not tracked.`, [
      `Run 'dub track ${branch} --parent <branch>' to track it first.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }

  const entry = stack.branches.find((b) => b.name === branch);
  if (!entry) {
    throw new DubError(`Branch '${branch}' is missing from tracked stack.`, [
      "Run 'dub doctor' to inspect the stack for metadata damage.",
    ]);
  }

  if (entry.type === 'root') {
    throw new DubError(`Cannot unlink root branch '${branch}'.`, [
      'Pick a non-root branch — root branches have no parent edge to remove.',
      `Run 'dub untrack ${branch}' to drop the root from tracking entirely.`,
    ]);
  }

  const previousParent = entry.parent;
  if (!previousParent) {
    throw new DubError(
      `Branch '${branch}' has corrupt metadata: non-root entry with no parent.`,
      [
        "Run 'dub doctor' to inspect the stack for damage.",
        `Run 'dub track ${branch} --parent <branch>' to repair the parent link.`,
      ],
    );
  }

  const trunkEntry = stack.branches.find((b) => b.type === 'root');
  if (!trunkEntry) {
    throw new DubError(`Stack '${stack.id}' has no root branch.`, [
      "Run 'dub doctor' to inspect the stack for metadata damage.",
    ]);
  }
  const trunkName = trunkEntry.name;

  const descendants = getDescendants(stack, branch);
  const directChildren = stack.branches
    .filter((b) => b.parent === branch)
    .map((b) => b.name);

  // Plan retarget. We retarget against the original trunk because `<branch>`
  // is being promoted to a standalone root; on GitHub the PR still needs a
  // real base branch, and trunk is the natural fallback.
  let plannedRetarget: {
    branch: string;
    newBase: string;
    prNumber: number;
  } | null = null;
  if (!options.noRetarget && entry.pr_number != null) {
    await ensureGhInstalled();
    await checkGhAuth();
    const info = await getBranchPrSyncInfo(branch, cwd);
    if (info.state === 'OPEN' && info.baseRefName !== trunkName) {
      plannedRetarget = {
        branch,
        newBase: trunkName,
        prNumber: entry.pr_number,
      };
    }
  }

  const originalBranch = await getCurrentBranch(cwd);
  const previousState = structuredClone(state);

  // Journal the retarget BEFORE touching state so a crash between the journal
  // write and the actual `gh pr edit` is recoverable via `dub continue`. The
  // state split itself is atomic (single `writeState`), so no reparent ops
  // need journaling.
  const journal = await startCleanupJournal(cwd);
  if (plannedRetarget) {
    await appendCleanupOperation(cwd, journal, {
      type: 'retarget',
      branch: plannedRetarget.branch,
      newBase: plannedRetarget.newBase,
    });
  }

  const movedNames = new Set<string>(
    options.orphanChildren ? [branch] : [branch, ...descendants],
  );

  // Orphan-children: each direct child of <branch> chains onto the old parent
  // so the original stack stays connected. Grandchildren keep their existing
  // (still-tracked) parent pointers.
  if (options.orphanChildren) {
    for (const b of stack.branches) {
      if (b.parent === branch) {
        b.parent = previousParent;
      }
    }
  }

  const movedBranches = stack.branches.filter((b) => movedNames.has(b.name));
  stack.branches = stack.branches.filter((b) => !movedNames.has(b.name));

  // Promote <branch> to a new root inside the new stack.
  for (const b of movedBranches) {
    if (b.name === branch) {
      b.parent = null;
      b.type = 'root';
      // `parent_revision` tracked the *prior* parent's tip — meaningless on a
      // root branch. Drop it so `dub restack` doesn't try to use it as the
      // rebase upstream.
      b.parent_revision = null;
    }
  }

  const newStack: Stack = {
    id: crypto.randomUUID(),
    branches: movedBranches,
  };
  state.stacks.push(newStack);
  // Drop stacks that became empty (e.g. orphan-children on a branch with no
  // siblings could leave the original stack with branches we just moved out).
  state.stacks = state.stacks.filter((s) => s.branches.length > 0);

  assertStateInvariants(state.stacks);
  await writeState(state, cwd);

  // Save undo BEFORE the retarget so a crash mid-`gh pr edit` leaves both an
  // undo entry (full rollback) AND the journal (forward replay) on disk.
  await saveUndoEntry(
    {
      operation: 'unlink',
      timestamp: new Date().toISOString(),
      previousBranch: originalBranch,
      previousState,
      branchTips: {},
      createdBranches: [],
    },
    cwd,
  );

  let retargeted = false;
  let prNumber: number | undefined;
  let retargetSkipped = false;

  if (plannedRetarget) {
    await retargetPrBase(plannedRetarget.branch, plannedRetarget.newBase, cwd);
    retargeted = true;
    prNumber = plannedRetarget.prNumber;
  } else if (options.noRetarget && entry.pr_number != null) {
    retargetSkipped = true;
    prNumber = entry.pr_number;
  }

  await clearCleanupJournal(cwd);

  return {
    branch,
    previousParent,
    newStackId: newStack.id,
    trunk: trunkName,
    movedDescendants: options.orphanChildren ? [] : descendants,
    orphanedChildren: options.orphanChildren ? directChildren : [],
    retargeted,
    ...(prNumber != null ? { prNumber } : {}),
    retargetSkipped,
  };
}
