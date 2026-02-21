import { getCurrentBranch } from '../lib/git';
import { findStackForBranch, readState, type Stack } from '../lib/state';

export interface BranchInfoResult {
  currentBranch: string;
  tracked: boolean;
  stackId: string | null;
  root: string | null;
  parent: string | null;
  children: string[];
}

function findRootName(stack: Stack): string | null {
  return stack.branches.find((branch) => branch.type === 'root')?.name ?? null;
}

function getChildren(stack: Stack, branchName: string): string[] {
  return stack.branches
    .filter((branch) => branch.parent === branchName)
    .map((branch) => branch.name)
    .sort();
}

/**
 * Returns tracked branch metadata for the current branch.
 */
export async function branchInfo(
  cwd: string,
  branchName?: string,
): Promise<BranchInfoResult> {
  const state = await readState(cwd);
  const resolvedBranch = branchName ?? (await getCurrentBranch(cwd));
  const stack = findStackForBranch(state, resolvedBranch);

  if (!stack) {
    return {
      currentBranch: resolvedBranch,
      tracked: false,
      stackId: null,
      root: null,
      parent: null,
      children: [],
    };
  }

  const current = stack.branches.find(
    (branch) => branch.name === resolvedBranch,
  );

  return {
    currentBranch: resolvedBranch,
    tracked: true,
    stackId: stack.id,
    root: findRootName(stack),
    parent: current?.parent ?? null,
    children: getChildren(stack, resolvedBranch),
  };
}

/**
 * Formats branch info in a human-readable layout.
 */
export function formatBranchInfo(info: BranchInfoResult): string {
  if (!info.tracked) {
    return [
      `Branch: ${info.currentBranch}`,
      'Tracked: no',
      'Status: not tracked by DubStack',
    ].join('\n');
  }

  const childrenLabel =
    info.children.length > 0 ? info.children.join(', ') : '(none)';
  return [
    `Branch: ${info.currentBranch}`,
    'Tracked: yes',
    `Stack ID: ${info.stackId ?? '(unknown)'}`,
    `Root: ${info.root ?? '(unknown)'}`,
    `Parent: ${info.parent ?? '(root)'}`,
    `Children: ${childrenLabel}`,
  ].join('\n');
}
