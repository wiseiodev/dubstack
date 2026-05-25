import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { DubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { readState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
import {
  getUntrackContext,
  type UntrackResult,
  untrackBranch,
} from '../lib/untrack';

interface UntrackCommandOptions {
  downstack?: boolean;
  interactive?: boolean;
  dryRun?: boolean;
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirmDownstack(branch: string, descendants: string[]) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Branch '${branch}' has descendants (${descendants.join(', ')}). Untrack them too? [y/N] `,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

export async function untrack(
  cwd: string,
  branchArg?: string,
  options: UntrackCommandOptions = {},
): Promise<UntrackResult> {
  const branch = branchArg ?? (await getCurrentBranch(cwd));
  const interactive = options.interactive ?? isInteractiveShell();
  let downstack = options.downstack ?? false;

  const context = await getUntrackContext(cwd, branch);
  if (context.descendants.length > 0 && !downstack) {
    if (!interactive) {
      throw new DubError(
        `Branch '${branch}' has descendants (${context.descendants.join(', ')}). Re-run with --downstack or interactive mode.`,
        [
          `Re-run with '--downstack' to untrack '${branch}' and its descendants.`,
          'Re-run interactively to confirm dropping the descendants.',
        ],
      );
    }
    downstack = await confirmDownstack(branch, context.descendants);
  }

  const dryRun = options.dryRun ?? false;
  const previousState = await readState(cwd).catch(() => null);
  const currentBranch = await getCurrentBranch(cwd).catch(() => branch);
  const result = await untrackBranch(cwd, { branch, downstack, dryRun });
  if (!dryRun && previousState && result.removed.length > 0) {
    await saveUndoEntry(
      {
        operation: 'untrack',
        timestamp: new Date().toISOString(),
        previousBranch: currentBranch,
        previousState: structuredClone(previousState),
        branchTips: {},
        createdBranches: [],
        summary: `untrack ${result.removed.join(', ')}`,
      },
      cwd,
    );
  }
  return result;
}
