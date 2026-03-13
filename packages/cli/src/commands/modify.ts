import { DubError } from '../lib/errors';
import {
  amendCommit,
  branchExists,
  checkoutBranch,
  commit,
  getBranchTip,
  getCurrentBranch,
  getDiff,
  hasStagedChanges,
  interactiveRebase,
  interactiveStage,
  stageAll,
  stageUpdate,
} from '../lib/git';
import { getParent, readState } from '../lib/state';
import { restack } from './restack';

/**
 * Options for the modify command.
 */
interface ModifyOptions {
  /** Stage all changes before committing. */
  all?: boolean;
  /** Create a new commit instead of amending. */
  commit?: boolean;
  /** Open editor to edit the commit message. */
  edit?: boolean;
  /** Start an interactive rebase on the branch commits. */
  interactiveRebase?: boolean;
  /** Amend staged changes to the specified branch. */
  into?: string;
  /** Message for the new or amended commit. */
  message?: string | string[];
  /** Pick hunks to stage before committing. */
  patch?: boolean;
  /** Set the author to the current user. */
  resetAuthor?: boolean;
  /** Stage all updates to tracked files. */
  update?: boolean;
  /** Show unified diff. */
  verbose?: number;
}

/**
 * Modifies the current branch by amending commits or creating new ones.
 * Automatically restacks descendant branches to keep the stack valid.
 *
 * @param cwd - The working directory.
 * @param options - Modification options.
 * @throws {DubError} If the parent branch cannot be determined for rebase, or if no changes are staged when creating a new commit.
 */
export async function modify(
  cwd: string,
  options: ModifyOptions,
): Promise<void> {
  const currentBranch = await getCurrentBranch(cwd);
  const state = await readState(cwd);
  const targetBranch = options.into;

  if (targetBranch && options.interactiveRebase) {
    throw new DubError('Cannot combine --into with --interactive-rebase.');
  }

  if (options.interactiveRebase) {
    const parent = getParent(state, currentBranch);
    if (!parent) {
      throw new DubError(
        `Could not determine parent branch for '${currentBranch}'. Cannot start interactive rebase.`,
      );
    }

    const parentTip = await getBranchTip(parent, cwd);

    console.log(`Starting interactive rebase on top of '${parent}'...`);
    await interactiveRebase(parentTip, cwd);

    await restackChildren(cwd);
    return;
  }

  if (!targetBranch || targetBranch === currentBranch) {
    await runModifyFlow(cwd, options);
    return;
  }

  const target = await validateIntoTarget(
    cwd,
    state,
    currentBranch,
    targetBranch,
  );
  await modifyIntoTarget(cwd, options, currentBranch, target);
}

function normalizeMessage(message?: string | string[]): string | undefined {
  if (Array.isArray(message)) {
    const chunks = message.map((part) => part.trim()).filter(Boolean);
    return chunks.length > 0 ? chunks.join('\n\n') : undefined;
  }
  return message;
}

async function printVerboseDiff(cwd: string, level: number): Promise<void> {
  if (level < 1) return;

  const staged = await getDiff(cwd, true);
  console.log(staged || '(no staged diff)');

  if (level > 1) {
    const unstaged = await getDiff(cwd, false);
    console.log(unstaged || '(no unstaged diff)');
  }
}

async function runModifyFlow(
  cwd: string,
  options: ModifyOptions,
): Promise<'success' | 'up-to-date' | 'conflict' | 'failed'> {
  if (options.patch) {
    await interactiveStage(cwd);
  } else if (options.all) {
    await stageAll(cwd);
  } else if (options.update) {
    await stageUpdate(cwd);
  }

  await printVerboseDiff(cwd, options.verbose ?? 0);

  const hasStaged = await hasStagedChanges(cwd);
  const shouldCreateNew = options.commit;
  const message = normalizeMessage(options.message);
  const noEdit = !options.edit && !!message;

  if (shouldCreateNew) {
    if (!hasStaged) {
      throw new DubError('No staged changes to commit.');
    }
    await commit(cwd, { message, noEdit: !options.edit });
  } else {
    // When amending, git commit --amend handles empty staged changes by allowing rewording
    await amendCommit(cwd, { message, noEdit });
  }

  return restackChildren(cwd);
}

async function validateIntoTarget(
  cwd: string,
  state: Awaited<ReturnType<typeof readState>>,
  currentBranch: string,
  targetBranch: string,
): Promise<string> {
  if (!(await branchExists(targetBranch, cwd))) {
    throw new DubError(`Target branch '${targetBranch}' not found.`);
  }

  const currentStack = state.stacks.find((stack) =>
    stack.branches.some((branch) => branch.name === currentBranch),
  );
  if (!currentStack) {
    throw new DubError(
      `Current branch '${currentBranch}' is not part of a tracked stack.`,
    );
  }

  const target = currentStack.branches.find(
    (branch) => branch.name === targetBranch,
  );
  if (!target) {
    throw new DubError(
      `Target branch '${targetBranch}' is not in the current stack.`,
    );
  }

  if (target.type === 'root' || target.parent === null) {
    throw new DubError(`Cannot use --into with root branch '${targetBranch}'.`);
  }

  return targetBranch;
}

async function modifyIntoTarget(
  cwd: string,
  options: ModifyOptions,
  originalBranch: string,
  targetBranch: string,
): Promise<void> {
  let restackStatus: 'success' | 'up-to-date' | 'conflict' | 'failed' =
    'up-to-date';
  let primaryError: unknown;

  try {
    await checkoutBranch(targetBranch, cwd);
    restackStatus = await runModifyFlow(cwd, options);
  } catch (error) {
    primaryError = error;
  }

  if (restackStatus !== 'conflict') {
    try {
      await checkoutBranch(originalBranch, cwd);
    } catch (restoreError) {
      if (primaryError) {
        console.log(
          `⚠ Could not return to original branch '${originalBranch}'.`,
        );
        console.log(
          `  ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      } else {
        throw restoreError;
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }
}

/**
 * Trigger a restack of the stack to ensure children are rebased onto the new tip.
 *
 * @param cwd - The working directory.
 */
async function restackChildren(
  cwd: string,
): Promise<'success' | 'up-to-date' | 'conflict' | 'failed'> {
  try {
    const result = await restack(cwd);
    if (result.status === 'conflict') {
      console.log(
        '⚠ Modify successful, but auto-restacking encountered conflicts.',
      );
      console.log("  Run 'dub restack --continue' to resolve.");
      return 'conflict';
    }
    return result.status;
  } catch (e) {
    if (e instanceof DubError && e.message.includes('Conflict')) {
      console.log(
        '⚠ Modify successful, but auto-restacking encountered conflicts.',
      );
      console.log("  Run 'dub restack --continue' to resolve.");
      return 'conflict';
    } else {
      console.log('⚠ Modify successful, but auto-restacking failed.');
      console.log(`  ${e instanceof Error ? e.message : String(e)}`);
      return 'failed';
    }
  }
}
