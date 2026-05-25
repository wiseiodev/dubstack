import { DubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { findStackForBranch, readState } from '../lib/state';

export interface ParentResult {
  branch: string;
  parent: string;
}

export async function parent(
  cwd: string,
  branchArg?: string,
): Promise<ParentResult> {
  const branch = branchArg ?? (await getCurrentBranch(cwd));
  const state = await readState(cwd);
  const stack = findStackForBranch(state, branch);
  if (!stack) {
    throw new DubError(`Branch '${branch}' is not tracked.`, [
      `Run 'dub track ${branch} --parent <branch>' to track it.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }
  const entry = stack.branches.find((candidate) => candidate.name === branch);
  if (!entry || !entry.parent) {
    throw new DubError(`Branch '${branch}' is at the root and has no parent.`, [
      "Run 'dub log' to inspect the stack and find a non-root branch.",
      "Run 'dub up' to move to the next branch above this trunk.",
    ]);
  }
  return { branch, parent: entry.parent };
}
