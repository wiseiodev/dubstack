import { DubError } from './errors';
import {
  checkoutBranch,
  deleteLocalBranch,
  fastForwardBranchToRef,
  formatWorktreeCheckoutSkipMessage,
  getBranchTip,
  getCommitSubjectsBetween,
  getCurrentBranch,
  getMergeBase,
  isWorkingTreeClean,
  listWorktreeCheckouts,
  mergeSquashAndCommit,
} from './git';
import { assertStateInvariants } from './invariants';
import { detectActiveOperation } from './operation-state';
import {
  type Branch,
  findStackForBranch,
  readState,
  type Stack,
  writeState,
} from './state';

export interface FoldPreview {
  branch: string;
  parent: string;
  childrenReparented: string[];
  /** Number of commits that will move from the branch onto its parent
   * (whether they end up as separate commits or one squash commit). */
  foldedCommits: number;
  /** Open or closed PR number recorded in state for the folded branch, if
   * any. Caller may want to mention it in a confirmation prompt. */
  prNumber: number | null;
}

export interface FoldOptions {
  /** Branch to fold (defaults to current branch). */
  branch?: string;
  /** Squash commits into one before folding (default keeps commits). */
  squash?: boolean;
}

export interface FoldResult {
  branch: string;
  parent: string;
  newParentTip: string;
  /** Number of commits that moved from the folded branch onto its parent. */
  foldedCommits: number;
  childrenReparented: string[];
  prNumber: number | null;
}

interface ResolvedFoldTarget {
  state: { stacks: Stack[] };
  stack: Stack;
  branch: Branch;
  branchName: string;
  parent: string;
}

/**
 * Resolves the branch to fold and validates it is foldable. Shared by the
 * preview-only path (so we can ask the user to confirm before mutating
 * anything) and the apply path — kept as the single source of truth for
 * "is this branch foldable?" so both paths stay in lockstep.
 */
async function resolveFoldTarget(
  cwd: string,
  branchArg: string | undefined,
): Promise<ResolvedFoldTarget> {
  const branchName = branchArg ?? (await getCurrentBranch(cwd));
  const state = await readState(cwd);
  const stack = findStackForBranch(state, branchName);
  if (!stack) {
    throw new DubError(`Branch '${branchName}' is not tracked.`, [
      `Run 'dub track ${branchName} --parent <branch>' to track it.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }
  const branch = stack.branches.find((b) => b.name === branchName);
  if (!branch) {
    throw new DubError(
      `Branch '${branchName}' is missing from tracked stack.`,
      ["Run 'dub doctor' to inspect the stack for metadata damage."],
    );
  }
  if (branch.type === 'root' || !branch.parent) {
    throw new DubError(`Cannot fold root branch '${branchName}'.`, [
      "Run 'dub log' to inspect the stack and pick a non-root branch.",
      `Run 'dub checkout <branch>' to switch to a non-root branch, then rerun 'dub fold'.`,
    ]);
  }
  const parentBranch = stack.branches.find((b) => b.name === branch.parent);
  if (parentBranch?.type === 'root') {
    throw new DubError(
      `Cannot fold '${branchName}' into trunk '${branch.parent}'.`,
      [
        `Run 'dub merge-next' to land '${branchName}' onto trunk via PR instead.`,
        "Run 'dub log' to inspect the stack.",
      ],
    );
  }
  return { state, stack, branch, branchName, parent: branch.parent };
}

/**
 * Computes a preview of a fold without mutating state. Used by the CLI to
 * render a confirmation prompt that names every child that will be
 * re-parented and counts the commits that will be folded.
 */
export async function getFoldPreview(
  cwd: string,
  options: FoldOptions = {},
): Promise<FoldPreview> {
  const { stack, branch, branchName, parent } = await resolveFoldTarget(
    cwd,
    options.branch,
  );
  const childrenReparented = stack.branches
    .filter((b) => b.parent === branchName)
    .map((b) => b.name)
    .sort();

  let foldedCommits = 0;
  try {
    const parentTip = await getBranchTip(parent, cwd);
    const branchTip = await getBranchTip(branchName, cwd);
    if (parentTip !== branchTip) {
      const subjects = await getCommitSubjectsBetween(
        parentTip,
        branchTip,
        cwd,
      );
      foldedCommits = subjects.length;
    }
  } catch {
    foldedCommits = 0;
  }

  return {
    branch: branchName,
    parent,
    childrenReparented,
    foldedCommits,
    prNumber: branch.pr_number,
  };
}

/**
 * Folds a branch into its parent.
 *
 * Flow:
 *   1. Validate the branch is tracked, not root, and parent is not trunk.
 *   2. Require a clean working tree.
 *   3. Require the branch to be up-to-date with its parent (parent tip
 *      matches the branch's recorded parent_revision) so the fold is a
 *      pure fast-forward / squash on top of the current parent.
 *   4. With `--squash`, build a squash commit on parent from the branch's
 *      unique commits. Otherwise fast-forward parent to the branch tip.
 *   5. Re-parent the branch's children onto the branch's former parent.
 *   6. Delete the now-folded branch locally.
 *   7. Persist state. Callers handle PR closure and downstream restack.
 *
 * Closing PRs and restacking descendants live in the command layer so this
 * library function stays free of network IO and easy to unit test.
 */
export async function foldBranch(
  cwd: string,
  options: FoldOptions = {},
): Promise<FoldResult> {
  const activeOperation = await detectActiveOperation(cwd);
  if (activeOperation !== 'none') {
    throw new DubError(
      `Cannot fold: a '${activeOperation}' operation is already in progress.`,
      activeOperation === 'rebase'
        ? [
            "Run 'git rebase --continue' or 'git rebase --abort' to finish the rebase, then retry.",
            "Run 'dub continue' or 'dub abort' if dubstack started the rebase.",
          ]
        : [
            "Run 'dub continue' to resume the operation, or 'dub abort' to cancel it.",
            "Run 'dub log' to inspect the stack once the operation completes.",
          ],
    );
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub fold'.",
      'Run \'dub modify -am "<message>"\' to commit the changes onto the current branch.',
    ]);
  }

  const {
    state,
    stack,
    branch,
    branchName,
    parent: parentName,
  } = await resolveFoldTarget(cwd, options.branch);

  const worktreeCheckouts = await listWorktreeCheckouts(cwd);
  const branchWorktree = worktreeCheckouts.get(branchName);
  if (branchWorktree) {
    throw new DubError(
      `Cannot fold '${branchName}': it is checked out in another worktree.`,
      [
        formatWorktreeCheckoutSkipMessage(
          branchName,
          branchWorktree,
          'dub fold',
        ),
        `Close the worktree at '${branchWorktree}' or fold from that worktree instead.`,
      ],
    );
  }
  const parentWorktree = worktreeCheckouts.get(parentName);
  if (parentWorktree) {
    throw new DubError(
      `Cannot fold into '${parentName}': it is checked out in another worktree.`,
      [
        formatWorktreeCheckoutSkipMessage(
          parentName,
          parentWorktree,
          'dub fold',
        ),
        `Close the worktree at '${parentWorktree}' or run 'dub fold' from that worktree.`,
      ],
    );
  }

  const parentTip = await getBranchTip(parentName, cwd);
  const branchTip = await getBranchTip(branchName, cwd);

  if (parentTip === branchTip) {
    throw new DubError(
      `Branch '${branchName}' has no commits to fold into '${parentName}'.`,
      [
        `Run 'dub delete ${branchName}' to remove the empty branch instead.`,
        `Run 'git log ${parentName}..${branchName}' to confirm there are no unique commits.`,
      ],
    );
  }

  // Staleness guard: parent must not have advanced past the point this
  // branch was last rebased onto it. We trust `parent_revision` when set;
  // otherwise we fall back to merge-base — if the merge-base lags behind
  // the current parent tip, parent has moved since branch diverged and
  // fold would silently absorb unrelated history.
  const referenceTip =
    branch.parent_revision ?? (await getMergeBase(parentName, branchName, cwd));
  if (referenceTip !== parentTip) {
    throw new DubError(
      `Branch '${branchName}' is not up to date with parent '${parentName}'.`,
      [
        `Run 'dub restack' to rebase '${branchName}' onto the latest '${parentName}', then retry.`,
        `Run 'dub log' to inspect the stack for drift.`,
      ],
    );
  }

  const children = stack.branches
    .filter((b) => b.parent === branchName)
    .map((b) => b.name)
    .sort();
  const subjects = await getCommitSubjectsBetween(parentTip, branchTip, cwd);
  const foldedCommits = subjects.length;

  const originalBranch = await getCurrentBranch(cwd);
  if (originalBranch !== parentName) {
    await checkoutBranch(parentName, cwd);
  }

  if (options.squash) {
    const message = buildSquashMessage(branchName, subjects);
    await mergeSquashAndCommit(branchName, message, cwd);
  } else {
    const fastForwarded = await fastForwardBranchToRef(
      parentName,
      branchName,
      cwd,
    );
    if (!fastForwarded) {
      throw new DubError(
        `Cannot fold '${branchName}' into '${parentName}': fast-forward refused.`,
        [
          `Run 'dub restack' to bring '${branchName}' up to date with '${parentName}', then retry.`,
          `Run 'git merge --ff-only ${branchName}' manually on '${parentName}' to inspect the underlying error.`,
          `Rerun 'dub fold --squash' to collapse '${branchName}' into one commit instead.`,
        ],
      );
    }
  }

  const newParentTip = await getBranchTip(parentName, cwd);

  await deleteLocalBranch(branchName, cwd, true);

  // Re-parent children of the folded branch onto its former parent. Record
  // the OLD branch tip as their parent_revision (not the new parent tip):
  // restack uses parent_revision as the "old base" for `git rebase --onto
  // <newParent> <oldBase> <child>`. In keep-commits mode old==new and
  // restack is a no-op; in squash mode restack rewrites children from the
  // dead branch tip onto the new squash commit. Setting parent_revision
  // to newParentTip would make restack a silent no-op and leave squashed
  // descendants orphaned on the deleted ref.
  for (const child of stack.branches) {
    if (child.parent === branchName) {
      child.parent = parentName;
      child.parent_revision = branchTip;
    }
  }
  stack.branches = stack.branches.filter((b) => b.name !== branchName);

  state.stacks = state.stacks.filter((s) => s.branches.length > 0);
  assertStateInvariants(state.stacks);
  await writeState(state, cwd);

  return {
    branch: branchName,
    parent: parentName,
    newParentTip,
    foldedCommits,
    childrenReparented: children,
    prNumber: branch.pr_number,
  };
}

function buildSquashMessage(branch: string, subjects: string[]): string {
  if (subjects.length === 0) {
    return `Folded ${branch}`;
  }
  const [first, ...rest] = subjects;
  if (rest.length === 0) {
    return first;
  }
  // Strip a leading bullet marker before re-bulleting so subjects that already
  // start with "* " don't render as "* * subject".
  const bullets = rest.map((s) => `* ${s.replace(/^\*\s+/, '')}`).join('\n');
  return `${first}\n\nSquashed from '${branch}':\n${bullets}`;
}
