import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { deleteTrackedBranch, getDeletePreview } from '../lib/delete';
import { DubError } from '../lib/errors';
import { branchExists, getBranchTip, getCurrentBranch } from '../lib/git';
import { readState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

interface DeleteCommandOptions {
  upstack?: boolean;
  downstack?: boolean;
  force?: boolean;
  quiet?: boolean;
  interactive?: boolean;
}

interface DeleteCommandResult {
  deleted: string[];
  reparented: Array<{ branch: string; parent: string | null }>;
  cancelled?: boolean;
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirmDelete(targets: string[]): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Delete ${targets.length} branch(es): ${targets.join(', ')}? [y/N] `,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

export async function deleteCommand(
  cwd: string,
  branchArg?: string,
  options: DeleteCommandOptions = {},
): Promise<DeleteCommandResult> {
  const branch = branchArg ?? (await getCurrentBranch(cwd));
  const interactive = options.interactive ?? isInteractiveShell();
  const preview = await getDeletePreview(cwd, {
    branch,
    upstack: options.upstack,
    downstack: options.downstack,
  });

  if (!options.force && !options.quiet) {
    if (!interactive) {
      throw new DubError('Delete requires confirmation.', [
        "Rerun 'dub delete <branch> --force' to skip the confirmation prompt.",
        "Rerun 'dub delete <branch> -q' to skip prompts and accept the planned deletion.",
        'Rerun the command in an interactive terminal to confirm interactively.',
      ]);
    }
    const confirmed = await confirmDelete(preview.targets);
    if (!confirmed) {
      return { deleted: [], reparented: [], cancelled: true };
    }
  }

  const previousState = await readState(cwd).catch(() => null);
  const currentBranch = await getCurrentBranch(cwd).catch(() => branch);
  const branchTips: Record<string, string> = {};
  for (const target of preview.targets) {
    if (await branchExists(target, cwd)) {
      try {
        branchTips[target] = await getBranchTip(target, cwd);
      } catch {
        // Branch tip unreadable; skip — undo will warn about the missing SHA.
      }
    }
  }
  const result = await deleteTrackedBranch(cwd, {
    branch,
    upstack: options.upstack ?? false,
    downstack: options.downstack ?? false,
    force: options.force ?? false,
  });
  if (previousState && result.deleted.length > 0) {
    await saveUndoEntry(
      {
        operation: 'delete',
        timestamp: new Date().toISOString(),
        previousBranch: currentBranch,
        previousState: structuredClone(previousState),
        branchTips,
        createdBranches: [],
        deletedBranches: result.deleted,
        summary: `delete ${result.deleted.join(', ')}`,
      },
      cwd,
    );
  }
  return { ...result, cancelled: false };
}
