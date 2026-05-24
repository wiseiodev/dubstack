import { DubError } from '../lib/errors';
import {
  countCommitsAhead,
  getBranchTip,
  getCurrentBranch,
  isWorkingTreeClean,
  softResetHead,
} from '../lib/git';
import { getParent, readState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

interface PopOptions {
  /** Number of commits to pop. Defaults to 1. */
  steps?: number;
}

interface PopResult {
  branch: string;
  steps: number;
  previousTip: string;
  newTip: string;
}

/**
 * Pops the last `steps` commits off the current branch into the staging area.
 *
 * Uses `git reset --soft HEAD~N` so the popped commits' changes are staged
 * for re-editing. Descendants are not restacked here — the next `dub modify`
 * that creates a new commit will restack them lazily.
 *
 * @throws {DubError} If steps is invalid, working tree is dirty, the branch
 *   has no parent in the stack, or the requested pop would cross the parent
 *   boundary.
 */
export async function pop(
  cwd: string,
  options: PopOptions = {},
): Promise<PopResult> {
  const steps = options.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new DubError('Steps must be a positive integer.', [
      "Pass '--steps <n>' as a positive integer (e.g. 'dub pop --steps 2').",
    ]);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError(
      'Working tree has uncommitted changes that would conflict with a pop.',
      [
        "Run 'git status' to see the uncommitted changes.",
        "Run 'git stash' to set the changes aside, then rerun 'dub pop'.",
        'Run \'dub modify -am "<message>"\' to commit the changes first.',
      ],
    );
  }

  const branch = await getCurrentBranch(cwd);
  const state = await readState(cwd);
  const parent = getParent(state, branch);
  if (!parent) {
    throw new DubError(`Could not determine parent branch for '${branch}'.`, [
      `Run 'dub track ${branch} --parent <branch>' to set the parent.`,
      "Run 'dub log' to inspect the stack and confirm tracking state.",
    ]);
  }

  const branchCommitCount = await countCommitsAhead(branch, parent, cwd);
  if (branchCommitCount === 0) {
    throw new DubError(
      `Nothing to pop: '${branch}' has no commits above '${parent}'.`,
      [
        `Make at least one commit on '${branch}' before popping.`,
        `Run 'dub log' to confirm the stack relationship between '${branch}' and '${parent}'.`,
      ],
    );
  }
  if (steps > branchCommitCount) {
    throw new DubError(
      `Cannot pop ${steps} commit(s): '${branch}' has only ${branchCommitCount} commit(s) above '${parent}'.`,
      [
        `Run 'git log --oneline ${parent}..${branch}' to see this branch's commits.`,
        `Rerun with '--steps ${branchCommitCount}' to pop everything down to the parent boundary.`,
      ],
    );
  }

  const previousTip = await getBranchTip(branch, cwd);

  await saveUndoEntry(
    {
      operation: 'pop',
      timestamp: new Date().toISOString(),
      previousBranch: branch,
      previousState: structuredClone(state),
      branchTips: { [branch]: previousTip },
      createdBranches: [],
    },
    cwd,
  );

  await softResetHead(steps, cwd);

  const newTip = await getBranchTip(branch, cwd);

  return { branch, steps, previousTip, newTip };
}
