import { DubError } from '../lib/errors';
import {
  amendCommit,
  branchExists,
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
import { getDescendants } from '../lib/graph';
import { findStackForBranch, getParent, readState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
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
  /** Preview the planned mutation without amending, committing, or restacking. */
  dryRun?: boolean;
}

/**
 * Structured plan returned by `dub modify --dry-run`. Describes the staging,
 * commit, and restack actions that would otherwise mutate the repo.
 */
export interface ModifyPlan {
  branch: string;
  action: 'amend' | 'commit' | 'interactive-rebase';
  stage: 'all' | 'update' | 'patch' | 'none';
  hasStagedChanges: boolean;
  message: string | undefined;
  rebaseOnto?: string;
  descendantsToRestack: string[];
  dryRun: true;
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
): Promise<ModifyPlan | undefined> {
  const currentBranch = await getCurrentBranch(cwd);
  const state = await readState(cwd);
  const dryRun = options.dryRun ?? false;

  const stage: ModifyPlan['stage'] = options.patch
    ? 'patch'
    : options.all
      ? 'all'
      : options.update
        ? 'update'
        : 'none';

  const stack = findStackForBranch(state, currentBranch);
  const descendantsToRestack = stack
    ? getDescendants(stack, currentBranch)
    : [];
  const message = normalizeMessage(options.message);

  if (options.interactiveRebase) {
    const parent = getParent(state, currentBranch);
    if (!parent) {
      throw new DubError(
        `Could not determine parent branch for '${currentBranch}'.`,
        [
          `Run 'dub track ${currentBranch} --parent <branch>' to set the parent.`,
          "Run 'dub log' to inspect the stack and confirm tracking state.",
        ],
      );
    }

    if (dryRun) {
      return {
        branch: currentBranch,
        action: 'interactive-rebase',
        stage,
        hasStagedChanges: await hasStagedChanges(cwd),
        message,
        rebaseOnto: parent,
        descendantsToRestack,
        dryRun: true,
      };
    }

    const parentTip = await getBranchTip(parent, cwd);

    console.log(`Starting interactive rebase on top of '${parent}'...`);
    await recordModifyUndo(cwd, state, currentBranch);
    await interactiveRebase(parentTip, cwd);

    await restackChildren(cwd);
    return;
  }

  if (dryRun) {
    return {
      branch: currentBranch,
      action: options.commit ? 'commit' : 'amend',
      stage,
      hasStagedChanges: await hasStagedChanges(cwd),
      message,
      descendantsToRestack,
      dryRun: true,
    };
  }

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
  const noEdit = !options.edit && !!message;

  if (shouldCreateNew) {
    if (!hasStaged) {
      throw new DubError('No staged changes to commit.', [
        "Run 'git add <files>' to stage changes for the new commit.",
        'Rerun \'dub modify -ac -m "<message>"\' to stage all changes and commit.',
      ]);
    }
    await recordModifyUndo(cwd, state, currentBranch);
    await commit(cwd, { message, noEdit: !options.edit });
  } else {
    // When amending, git commit --amend handles empty staged changes by allowing rewording
    await recordModifyUndo(cwd, state, currentBranch);
    await amendCommit(cwd, { message, noEdit });
  }

  await restackChildren(cwd);
}

async function recordModifyUndo(
  cwd: string,
  state: import('../lib/state').DubState,
  currentBranch: string,
): Promise<void> {
  const branchTips: Record<string, string> = {};
  const stack = findStackForBranch(state, currentBranch);
  const branchesToSnapshot = new Set<string>([currentBranch]);
  if (stack) {
    for (const name of getDescendants(stack, currentBranch)) {
      branchesToSnapshot.add(name);
    }
  }
  for (const name of branchesToSnapshot) {
    if (await branchExists(name, cwd)) {
      try {
        branchTips[name] = await getBranchTip(name, cwd);
      } catch {
        // Branch tip unreadable; skip.
      }
    }
  }
  await saveUndoEntry(
    {
      operation: 'modify',
      timestamp: new Date().toISOString(),
      previousBranch: currentBranch,
      previousState: structuredClone(state),
      branchTips,
      createdBranches: [],
      summary: `modify ${currentBranch}`,
    },
    cwd,
  );
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

/**
 * Trigger a restack of the stack to ensure children are rebased onto the new tip.
 *
 * @param cwd - The working directory.
 */
async function restackChildren(cwd: string): Promise<void> {
  try {
    await restack(cwd);
  } catch (e) {
    if (e instanceof DubError && e.message.includes('Conflict')) {
      console.log(
        '⚠ Modify successful, but auto-restacking encountered conflicts.',
      );
      console.log("  Run 'dub restack --continue' to resolve.");
    } else {
      console.log('⚠ Modify successful, but auto-restacking failed.');
      console.log(`  ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
