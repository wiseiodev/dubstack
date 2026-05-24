import {
  appendCleanupOperation,
  type CleanupJournal,
} from '../lib/cleanup-journal';
import { checkoutBranch } from '../lib/git';
import { getBranchPrSyncInfo, retargetPrBase } from '../lib/github';
import { findStackForBranch, type Stack, topologicalOrder } from '../lib/state';
import { submit } from './submit';

export async function retargetOpenPrBranches(
  stacks: Stack[],
  cwd: string,
  options: {
    dryRun?: boolean;
    branches?: string[];
    /**
     * When provided, each planned retarget is appended to the journal before
     * `gh pr edit` fires, so a crash mid-loop is recoverable by `dub continue`.
     */
    journal?: CleanupJournal;
  } = {},
): Promise<string[]> {
  const dryRun = options.dryRun ?? false;
  const targetBranches = options.branches ? new Set(options.branches) : null;
  const retargeted: string[] = [];

  for (const stack of stacks) {
    for (const branch of stack.branches) {
      if (branch.type === 'root' || !branch.parent) continue;
      if (targetBranches && !targetBranches.has(branch.name)) continue;
      const prInfo = await getBranchPrSyncInfo(branch.name, cwd);
      if (prInfo.state !== 'OPEN') continue;
      if (prInfo.baseRefName === branch.parent) continue;
      retargeted.push(branch.name);
      if (!dryRun) {
        if (options.journal) {
          await appendCleanupOperation(cwd, options.journal, {
            type: 'retarget',
            branch: branch.name,
            newBase: branch.parent,
          });
        }
        await retargetPrBase(branch.name, branch.parent, cwd);
      }
    }
  }

  return retargeted.sort();
}

export function hasNonRootBranches(stack: Stack): boolean {
  return stack.branches.some((branch) => branch.type !== 'root');
}

export function resolvePreferredBranch(
  workingStacks: Stack[],
  originalBranch: string,
  scopeStacks: Stack[],
): string | null {
  const originalEntry = findStackForBranch(
    { stacks: workingStacks },
    originalBranch,
  )?.branches.find((branch) => branch.name === originalBranch);
  if (originalEntry && originalEntry.type !== 'root') {
    return originalBranch;
  }

  const scopedIds = new Set(scopeStacks.map((stack) => stack.id));
  const preferredStack =
    workingStacks.find((stack) => scopedIds.has(stack.id)) ?? workingStacks[0];
  if (!preferredStack) return null;

  if (originalEntry?.type === 'root') {
    return (
      topologicalOrder(preferredStack).find((branch) => branch.type !== 'root')
        ?.name ??
      preferredStack.branches.find((branch) => branch.type === 'root')?.name ??
      null
    );
  }

  return (
    topologicalOrder(preferredStack).find((branch) => branch.type !== 'root')
      ?.name ??
    preferredStack.branches.find((branch) => branch.type === 'root')?.name ??
    null
  );
}

export async function submitRefreshedStacks(
  cwd: string,
  stacks: Stack[],
  options: { all: boolean },
): Promise<string[]> {
  if (options.all) {
    const pushed = new Set<string>();
    const submitTargets = stacks
      .map(
        (stack) =>
          topologicalOrder(stack).find((branch) => branch.type !== 'root')
            ?.name,
      )
      .filter((branchName): branchName is string => Boolean(branchName));
    for (const branchName of submitTargets) {
      await checkoutBranch(branchName, cwd);
      const result = await submit(cwd, false, {
        stack: true,
      });
      for (const branch of result.pushed) {
        pushed.add(branch);
      }
    }
    return [...pushed].sort();
  }

  const result = await submit(cwd, false, {
    stack: true,
  });
  return result.pushed;
}
