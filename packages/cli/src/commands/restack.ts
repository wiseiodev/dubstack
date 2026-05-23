import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  formatWorktreeCheckoutSkipMessage,
  getBranchTip,
  getCurrentBranch,
  getMergeBase,
  rebaseContinue as gitRebaseContinue,
  hasUniquePatchCommits,
  isWorkingTreeClean,
  listWorktreeCheckouts,
  rebaseOnto,
} from '../lib/git';
import { createProgress, getActiveProgress } from '../lib/progress';
import {
  getDubDir,
  readState,
  type Stack,
  topologicalOrder,
  writeState,
} from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

interface RestackStep {
  branch: string;
  parent: string;
  parentOldTip: string;
  parentNewTip?: string;
  worktreePath?: string;
  status: 'pending' | 'done' | 'skipped' | 'conflicted';
}

interface RestackProgress {
  originalBranch: string;
  steps: RestackStep[];
}

interface RestackResult {
  status: 'success' | 'conflict' | 'up-to-date';
  rebased: string[];
  conflictBranch?: string;
}

/**
 * Rebases all branches in the current stack onto their updated parents.
 *
 * Uses a snapshot-before-rebase strategy: captures every branch's tip
 * BEFORE starting any rebases, then uses `git rebase --onto <parent_new_tip>
 * <parent_old_tip> <child>`. This prevents the duplication bug where a child
 * replays its parent's already-rebased commits.
 *
 * On conflict, writes progress to `restack-progress.json` so
 * `dub restack --continue` can resume.
 *
 * @param cwd - Working directory
 * @returns Result with status, list of rebased branches, and optional conflict branch
 * @throws {DubError} If not initialized, dirty tree, not in a stack, or branch missing
 */
export async function restack(cwd: string): Promise<RestackResult> {
  const state = await readState(cwd);

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub restack'.",
      'Run \'dub modify -am "<message>"\' to commit the changes onto the current branch.',
    ]);
  }

  const originalBranch = await getCurrentBranch(cwd);
  const targetStacks = getTargetStacks(state.stacks, originalBranch);
  const worktreeCheckouts = await listWorktreeCheckouts(cwd);

  if (targetStacks.length === 0) {
    throw new DubError(`Branch '${originalBranch}' is not part of any stack.`, [
      "Run 'dub create <branch>' to start a stack from this branch.",
      "Run 'dub track <branch>' to track this branch on a parent.",
      "Run 'dub checkout <branch>' to switch to a tracked branch.",
    ]);
  }

  const allBranches = targetStacks.flatMap((s) => s.branches);
  for (const branch of allBranches) {
    if (!(await branchExists(branch.name, cwd))) {
      throw new DubError(
        `Branch '${branch.name}' is tracked in state but no longer exists in git.`,
        [
          `Run 'dub untrack ${branch.name}' to remove it from the stack.`,
          `Run 'git checkout -b ${branch.name} <sha>' to recreate the branch before retrying.`,
          "Run 'dub doctor' to inspect the stack for related issues.",
        ],
      );
    }
  }

  // Snapshot all branch tips BEFORE building steps or rebasing
  const branchTips: Record<string, string> = {};
  for (const branch of allBranches) {
    branchTips[branch.name] = await getBranchTip(branch.name, cwd);
  }

  const steps = await buildRestackSteps(targetStacks, cwd, worktreeCheckouts);

  if (steps.length === 0) {
    return { status: 'up-to-date', rebased: [] };
  }

  for (const step of steps) {
    if (step.status === 'skipped' && step.worktreePath) {
      console.log(
        formatWorktreeCheckoutSkipMessage(
          step.branch,
          step.worktreePath,
          'dub restack',
        ),
      );
    }
  }

  if (steps.every((step) => step.status === 'skipped')) {
    return { status: 'up-to-date', rebased: [] };
  }

  await saveUndoEntry(
    {
      operation: 'restack',
      timestamp: new Date().toISOString(),
      previousBranch: originalBranch,
      previousState: structuredClone(state),
      branchTips,
      createdBranches: [],
    },
    cwd,
  );

  const progress: RestackProgress = { originalBranch, steps };
  await writeProgress(progress, cwd);

  return executeRestackSteps(progress, cwd);
}

/**
 * Continues a restack after conflict resolution.
 *
 * Reads the saved progress file, finishes the in-progress rebase,
 * then resumes with remaining branches.
 *
 * @param cwd - Working directory
 * @throws {DubError} If no restack is in progress
 */
export async function restackContinue(cwd: string): Promise<RestackResult> {
  const progress = await readProgress(cwd);

  if (!progress) {
    throw new DubError('No restack in progress.', [
      "Run 'dub restack' to start restacking the current stack.",
    ]);
  }

  await gitRebaseContinue(cwd);

  const conflictedStep = progress.steps.find((s) => s.status === 'conflicted');
  if (conflictedStep) {
    conflictedStep.status = 'done';
    const state = await readState(cwd);
    const parentNewTip =
      conflictedStep.parentNewTip ??
      (await getBranchTip(conflictedStep.parent, cwd));
    updateParentRevision(state, conflictedStep.branch, parentNewTip);
    await writeState(state, cwd);
  }

  return executeRestackSteps(progress, cwd);
}

async function executeRestackSteps(
  progress: RestackProgress,
  cwd: string,
): Promise<RestackResult> {
  const rebased: string[] = [];
  const state = await readState(cwd);
  const pendingSteps = progress.steps.filter((s) => s.status === 'pending');
  const ownsBar = getActiveProgress() == null;
  const bar = ownsBar ? createProgress() : null;
  if (bar && pendingSteps.length > 0) {
    bar.start('🥞 Restacking', pendingSteps.length);
  }
  let stepIndex = 0;

  try {
    for (const step of progress.steps) {
      if (step.status !== 'pending') {
        if (step.status === 'done') rebased.push(step.branch);
        continue;
      }
      stepIndex += 1;
      bar?.update('🥞 Restacking', stepIndex, step.branch);

      const parentNewTip = await getBranchTip(step.parent, cwd);
      if (parentNewTip === step.parentOldTip) {
        step.status = 'skipped';
        updateParentRevision(state, step.branch, parentNewTip);
        await writeProgress(progress, cwd);
        continue;
      }

      const hasUniquePatches = await hasUniquePatchCommits(
        parentNewTip,
        step.branch,
        cwd,
      );
      if (!hasUniquePatches) {
        step.status = 'skipped';
        await writeProgress(progress, cwd);
        continue;
      }

      try {
        await rebaseOnto(parentNewTip, step.parentOldTip, step.branch, cwd);
        step.status = 'done';
        rebased.push(step.branch);
        updateParentRevision(state, step.branch, parentNewTip);
        await writeProgress(progress, cwd);
      } catch (error) {
        if (error instanceof DubError && error.message.includes('Conflict')) {
          step.status = 'conflicted';
          step.parentNewTip = parentNewTip;
          await writeProgress(progress, cwd);
          return { status: 'conflict', rebased, conflictBranch: step.branch };
        }
        throw error;
      }
    }

    await writeState(state, cwd);
    await clearProgress(cwd);
    await checkoutBranch(progress.originalBranch, cwd);

    const allSkipped = progress.steps.every(
      (s) => s.status === 'skipped' || s.status === 'done',
    );
    return {
      status: rebased.length === 0 && allSkipped ? 'up-to-date' : 'success',
      rebased,
    };
  } finally {
    bar?.stop();
  }
}

function updateParentRevision(
  state: { stacks: Stack[] },
  branchName: string,
  parentRevision: string,
): void {
  for (const stack of state.stacks) {
    const branch = stack.branches.find((b) => b.name === branchName);
    if (branch) {
      branch.parent_revision = parentRevision;
      return;
    }
  }
}

function getTargetStacks(stacks: Stack[], currentBranch: string): Stack[] {
  // If current branch is a root of any stacks, restack all of them
  const rootStacks = stacks.filter((s) =>
    s.branches.some((b) => b.name === currentBranch && b.type === 'root'),
  );
  if (rootStacks.length > 0) return rootStacks;

  // Otherwise, find the stack containing the current branch
  const stack = stacks.find((s) =>
    s.branches.some((b) => b.name === currentBranch),
  );
  return stack ? [stack] : [];
}

async function buildRestackSteps(
  stacks: Stack[],
  cwd: string,
  worktreeCheckouts: Map<string, string> = new Map(),
): Promise<RestackStep[]> {
  const steps: RestackStep[] = [];

  for (const stack of stacks) {
    const ordered = topologicalOrder(stack);
    for (const branch of ordered) {
      if (branch.type === 'root' || !branch.parent) continue;
      const parentOldTip =
        branch.parent_revision ??
        (await getMergeBase(branch.parent, branch.name, cwd));
      steps.push({
        branch: branch.name,
        parent: branch.parent,
        parentOldTip,
        worktreePath: worktreeCheckouts.get(branch.name),
        status: worktreeCheckouts.has(branch.name) ? 'skipped' : 'pending',
      });
    }
  }

  return steps;
}

async function getProgressPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'restack-progress.json');
}

async function writeProgress(
  progress: RestackProgress,
  cwd: string,
): Promise<void> {
  const progressPath = await getProgressPath(cwd);
  fs.writeFileSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
}

async function readProgress(cwd: string): Promise<RestackProgress | null> {
  const progressPath = await getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return null;
  const raw = fs.readFileSync(progressPath, 'utf-8');
  return JSON.parse(raw) as RestackProgress;
}

async function clearProgress(cwd: string): Promise<void> {
  const progressPath = await getProgressPath(cwd);
  if (fs.existsSync(progressPath)) {
    fs.unlinkSync(progressPath);
  }
}
