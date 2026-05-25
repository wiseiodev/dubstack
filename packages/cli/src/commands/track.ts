import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { DubError } from '../lib/errors';
import { branchExists, getCurrentBranch } from '../lib/git';
import { readState } from '../lib/state';
import { type TrackBranchResult, trackBranch } from '../lib/track';
import { saveUndoEntry } from '../lib/undo-log';

interface TrackOptions {
  parent?: string;
  interactive?: boolean;
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function promptForParent(
  branch: string,
  suggestedParent: string | null,
): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = suggestedParent ? ` [${suggestedParent}]` : '';
    const answer = await rl.question(
      `Parent branch for '${branch}'${suffix}: `,
    );
    const parent = answer.trim() || suggestedParent;
    if (!parent) {
      throw new DubError(`No parent selected for '${branch}'.`, [
        `Re-run with '--parent <branch>' to set the parent explicitly.`,
        "Run 'dub log' to see candidate parent branches.",
      ]);
    }
    return parent;
  } finally {
    rl.close();
  }
}

async function resolveSuggestedParent(
  cwd: string,
  branch: string,
  currentBranch: string,
): Promise<string | null> {
  if (currentBranch !== branch) return currentBranch;
  if (await branchExists('main', cwd)) return 'main';
  if (await branchExists('master', cwd)) return 'master';
  return null;
}

/**
 * Tracks a branch or re-parents an already tracked branch.
 */
export async function track(
  cwd: string,
  branchArg?: string,
  options: TrackOptions = {},
): Promise<TrackBranchResult> {
  const currentBranch = await getCurrentBranch(cwd);
  const branch = branchArg ?? currentBranch;
  const interactive = options.interactive ?? isInteractiveShell();

  let parent = options.parent;
  if (!parent) {
    const suggestedParent = await resolveSuggestedParent(
      cwd,
      branch,
      currentBranch,
    );
    if (interactive) {
      parent = await promptForParent(branch, suggestedParent);
    } else if (suggestedParent) {
      parent = suggestedParent;
    }
  }

  if (!parent) {
    throw new DubError(`Could not infer parent for '${branch}'.`, [
      `Re-run with '--parent <branch>' to set the parent explicitly.`,
      "Run 'dub log' to see candidate parent branches.",
    ]);
  }

  const previousState = await readState(cwd).catch(() => null);
  const result = await trackBranch(cwd, { branch, parent });
  if (previousState && result.status !== 'unchanged') {
    await saveUndoEntry(
      {
        operation: 'track',
        timestamp: new Date().toISOString(),
        previousBranch: currentBranch,
        previousState: structuredClone(previousState),
        branchTips: {},
        createdBranches: [],
        summary: `track ${branch} → ${parent}`,
      },
      cwd,
    );
  }
  return result;
}
