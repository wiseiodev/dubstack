import { DubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { findStackForBranch, readState } from '../lib/state';

interface TrunkResult {
  branch: string;
  trunk: string;
}

export async function trunk(
  cwd: string,
  branchArg?: string,
): Promise<TrunkResult> {
  const branch = branchArg ?? (await getCurrentBranch(cwd));
  const state = await readState(cwd);
  const stack = findStackForBranch(state, branch);
  if (!stack) {
    throw new DubError(
      `Branch '${branch}' is not tracked. Run 'dub track ${branch} --parent <branch>' first.`,
    );
  }
  const root = stack.branches.find((candidate) => candidate.type === 'root');
  if (!root) {
    throw new DubError(
      `Stack for '${branch}' is missing a root branch. Re-run 'dub track' to repair metadata.`,
    );
  }
  return { branch, trunk: root.name };
}
