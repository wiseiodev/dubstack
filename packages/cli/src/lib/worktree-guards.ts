import { DubError } from './errors';
import { listWorktreeCheckouts } from './git';

export interface WorktreeCheckoutConflict {
  branch: string;
  worktree: string;
}

/**
 * Refuses commands that would mutate a branch checked out in another worktree.
 *
 * Git rejects many of these operations mid-command. Surfacing the conflict
 * before writing undo/journal/state keeps recovery straightforward.
 */
export async function assertBranchesNotCheckedOutElsewhere(
  cwd: string,
  branches: Iterable<string>,
  command: string,
): Promise<void> {
  const conflict = await findWorktreeCheckoutConflict(cwd, branches);
  if (!conflict) return;

  throw new DubError(
    `Cannot run '${command}': branch '${conflict.branch}' is checked out in another worktree.`,
    [
      `The other worktree is '${conflict.worktree}'.`,
      `Run '${command}' from that worktree, or switch that worktree off '${conflict.branch}' and retry.`,
    ],
  );
}

export async function findWorktreeCheckoutConflict(
  cwd: string,
  branches: Iterable<string>,
): Promise<WorktreeCheckoutConflict | null> {
  const checkouts = await listWorktreeCheckouts(cwd);
  const seen = new Set<string>();

  for (const branch of branches) {
    if (seen.has(branch)) continue;
    seen.add(branch);
    const worktree = checkouts.get(branch);
    if (worktree) {
      return { branch, worktree };
    }
  }

  return null;
}
