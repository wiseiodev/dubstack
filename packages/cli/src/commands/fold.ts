import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { DubError } from '../lib/errors';
import {
  type FoldOptions,
  type FoldResult,
  foldBranch,
  getFoldPreview,
} from '../lib/fold';
import {
  type BranchPrLifecycleState,
  checkGhAuth,
  closePrWithComment,
  ensureGhInstalled,
  getPrStateByNumber,
} from '../lib/github';
import { restack } from './restack';

export interface FoldCommandOptions extends FoldOptions {
  force?: boolean;
  interactive?: boolean;
}

export interface FoldCommandResult extends FoldResult {
  cancelled: boolean;
  prClosed: boolean;
  /** Lifecycle state of the PR at the time of fold, if any. `null` when no
   * PR was attached to the folded branch. Lets the CLI tell the user why a
   * PR was (or wasn't) closed. */
  prPriorState: BranchPrLifecycleState | null;
  restacked: boolean;
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirmFold(
  branch: string,
  parent: string,
  childrenReparented: string[],
  squashedCommits: number,
  squash: boolean,
): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const mode = squash ? 'squash' : 'keep commits';
    const childSummary =
      childrenReparented.length > 0
        ? ` Re-parents ${childrenReparented.length} child(ren): ${childrenReparented.join(', ')}.`
        : '';
    const answer = await rl.question(
      `Fold '${branch}' (${squashedCommits} commit(s), ${mode}) into '${parent}' and delete '${branch}'?${childSummary} [y/N] `,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

const EMPTY_FOLD_RESULT_BASE = {
  branch: '',
  parent: '',
  newParentTip: '',
  squashedCommits: 0,
  childrenReparented: [] as string[],
  prNumber: null as number | null,
};

export async function fold(
  cwd: string,
  options: FoldCommandOptions = {},
): Promise<FoldCommandResult> {
  const interactive = options.interactive ?? isInteractiveShell();

  if (!options.force) {
    if (!interactive) {
      throw new DubError('Fold requires confirmation.', [
        "Rerun 'dub fold --force' to skip the confirmation prompt.",
        'Rerun the command in an interactive terminal to confirm interactively.',
      ]);
    }
    const preview = await getFoldPreview(cwd, options);
    const confirmed = await confirmFold(
      preview.branch,
      preview.parent,
      preview.childrenReparented,
      preview.squashedCommits,
      options.squash ?? false,
    );
    if (!confirmed) {
      return {
        ...EMPTY_FOLD_RESULT_BASE,
        branch: preview.branch,
        parent: preview.parent,
        squashedCommits: preview.squashedCommits,
        childrenReparented: preview.childrenReparented,
        cancelled: true,
        prClosed: false,
        prPriorState: null,
        restacked: false,
      };
    }
  }

  const result = await foldBranch(cwd, options);

  let prClosed = false;
  let prPriorState: BranchPrLifecycleState | null = null;
  if (result.prNumber != null) {
    try {
      await ensureGhInstalled();
      await checkGhAuth();
      // Only close PRs that are actually open. The pr_number in state is
      // set at submit time and never cleared, so it may point at an
      // already-merged or already-closed PR.
      prPriorState = await getPrStateByNumber(result.prNumber, cwd);
      if (prPriorState === 'OPEN') {
        await closePrWithComment(
          result.prNumber,
          `Folded into \`${result.parent}\` via \`dub fold\`.`,
          cwd,
        );
        prClosed = true;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠ Failed to close PR #${result.prNumber}: ${reason}. Close it manually if needed.`,
      );
    }
  }

  let restacked = false;
  if (result.childrenReparented.length > 0) {
    const restackResult = await restack(cwd);
    if (restackResult.status === 'conflict') {
      throw new DubError(
        `Fold complete but restack hit conflicts on '${restackResult.conflictBranch ?? 'unknown'}'.`,
        [
          'Resolve conflicts and stage the resolved files.',
          "Run 'dub continue --ai' to let DubStack try the resolution.",
          "Run 'dub continue' after resolving manually.",
          "Run 'dub abort' to cancel and roll back progress.",
        ],
      );
    }
    restacked = true;
  }

  return {
    ...result,
    cancelled: false,
    prClosed,
    prPriorState,
    restacked,
  };
}
