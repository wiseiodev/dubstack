import { DubError } from '../lib/errors';
import {
  checkoutBranch,
  fastForwardBranchToRef,
  fetchBranches,
  formatWorktreeCheckoutSkipMessage,
  getCurrentBranch,
  listWorktreeCheckouts,
  remoteBranchExists,
} from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrLifecycleState,
} from '../lib/github';
import {
  findStackForBranch,
  readState,
  type Stack,
  writeState,
} from '../lib/state';
import { restack } from './restack';
import {
  hasNonRootBranches,
  resolvePreferredBranch,
  retargetOpenPrBranches,
  submitRefreshedStacks,
} from './stack-maintenance';

export interface PostMergeResult {
  cleaned: string[];
  skipped: string[];
  reparented: Array<{ branch: string; parent: string | null }>;
  retargeted: string[];
  restacked: boolean;
  submitted: boolean;
  submittedBranches: string[];
  dryRun: boolean;
}

export async function postMerge(
  cwd: string,
  options: {
    all?: boolean;
    dryRun?: boolean;
    restack?: boolean;
    submit?: boolean;
  } = {},
): Promise<PostMergeResult> {
  await ensureGhInstalled();
  await checkGhAuth();

  const dryRun = options.dryRun ?? false;
  const shouldRestack = options.restack ?? true;
  const shouldSubmit = options.submit ?? true;

  const state = await readState(cwd);
  const originalBranch = await getCurrentBranch(cwd);
  const worktreeCheckouts = await listWorktreeCheckouts(cwd);
  const scopeStacks = options.all
    ? state.stacks
    : (() => {
        const stack = findStackForBranch(state, originalBranch);
        if (!stack) {
          throw new DubError(
            `Branch '${originalBranch}' is not part of any stack.`,
            [
              "Run 'dub create <branch>' to start a stack from this branch.",
              "Run 'dub post-merge --all' to process every tracked stack instead.",
              "Run 'dub checkout <branch>' to switch to a tracked branch.",
            ],
          );
        }
        return [stack];
      })();
  const workingStacks = dryRun ? structuredClone(scopeStacks) : scopeStacks;

  const result: PostMergeResult = {
    cleaned: [],
    skipped: [],
    reparented: [],
    retargeted: [],
    restacked: false,
    submitted: false,
    submittedBranches: [],
    dryRun,
  };
  let preferredBranch: string | null = null;
  const reparentedBranchNames = new Set<string>();

  for (const stack of workingStacks) {
    const mergedBottom = await getMergedBottomBranches(stack, cwd);
    for (const branchName of mergedBottom) {
      const worktreePath = worktreeCheckouts.get(branchName);
      if (worktreePath) {
        console.log(
          formatWorktreeCheckoutSkipMessage(
            branchName,
            worktreePath,
            'dub post-merge',
          ),
        );
        result.skipped.push(branchName);
        continue;
      }

      result.cleaned.push(branchName);
      const reparented = removeBranchFromStack(stack, branchName);
      result.reparented.push(...reparented);
      for (const entry of reparented) {
        reparentedBranchNames.add(entry.branch);
      }
    }
  }
  result.retargeted = await retargetOpenPrBranches(workingStacks, cwd, {
    dryRun,
    branches: [...reparentedBranchNames],
  });

  if (!dryRun) {
    await writeState(state, cwd);
  }

  if (!dryRun && shouldRestack && workingStacks.some(hasNonRootBranches)) {
    for (const stack of workingStacks) {
      if (!hasNonRootBranches(stack)) continue;
      const root = stack.branches.find(
        (branch) => branch.type === 'root',
      )?.name;
      if (!root) continue;
      await fetchBranches([root], cwd);
      if (await remoteBranchExists(root, cwd)) {
        const remoteRef = `origin/${root}`;
        const fastForwarded = await fastForwardBranchToRef(
          root,
          remoteRef,
          cwd,
        );
        if (!fastForwarded) {
          throw new DubError(
            `Post-merge could not fast-forward trunk '${root}' to '${remoteRef}'.`,
            [
              `Run 'git checkout ${root} && git pull --ff-only origin ${root}' to refresh trunk.`,
              "Rerun 'dub post-merge' once the trunk is current.",
              "Run 'dub sync' to reconcile divergence before retrying.",
            ],
          );
        }
      }
      await checkoutBranch(root, cwd);
      const restackResult = await restack(cwd);
      if (restackResult.status === 'conflict') {
        throw new DubError(
          `Post-merge restack hit conflicts on '${restackResult.conflictBranch ?? 'unknown'}'.`,
          [
            'Resolve conflicts and stage the resolved files.',
            "Run 'dub continue --ai' to let DubStack try the resolution.",
            "Run 'dub continue' after resolving manually.",
            "Run 'dub abort' to cancel and roll back progress.",
          ],
        );
      }
    }
    result.restacked = true;
  }

  if (!dryRun) {
    preferredBranch = resolvePreferredBranch(
      workingStacks,
      originalBranch,
      scopeStacks,
    );
    if (preferredBranch) {
      await checkoutBranch(preferredBranch, cwd);
    }
  }

  if (!dryRun && shouldSubmit) {
    const hasRefreshableBranches = workingStacks.some(hasNonRootBranches);
    if (hasRefreshableBranches) {
      result.submittedBranches = await submitRefreshedStacks(
        cwd,
        workingStacks,
        {
          all: options.all ?? false,
        },
      );
      result.submitted = true;
    }
  }
  if (!dryRun && preferredBranch) {
    await checkoutBranch(preferredBranch, cwd);
  }

  result.cleaned.sort();
  result.skipped.sort();
  result.retargeted.sort();
  return result;
}

async function getMergedBottomBranches(
  stack: Stack,
  cwd: string,
): Promise<string[]> {
  const branchMap = new Map(
    stack.branches.map((branch) => [branch.name, branch]),
  );
  const merged = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const branch of stack.branches) {
      if (branch.type === 'root') continue;
      if (merged.has(branch.name)) continue;

      const status = await getBranchPrLifecycleState(branch.name, cwd);
      if (status !== 'MERGED') continue;

      const parent = branch.parent ? branchMap.get(branch.parent) : null;
      const parentIsSatisfied =
        !parent || parent.type === 'root' || merged.has(parent.name);
      if (!parentIsSatisfied) continue;

      merged.add(branch.name);
      changed = true;
    }
  }

  return [...merged];
}

function removeBranchFromStack(
  stack: Stack,
  branchName: string,
): Array<{ branch: string; parent: string | null }> {
  const deleted = stack.branches.find((branch) => branch.name === branchName);
  if (!deleted) return [];
  const newParent = deleted.parent;

  const reparented: Array<{ branch: string; parent: string | null }> = [];
  for (const branch of stack.branches) {
    if (branch.parent !== branchName) continue;
    branch.parent = newParent;
    reparented.push({ branch: branch.name, parent: branch.parent });
  }
  stack.branches = stack.branches.filter(
    (branch) => branch.name !== branchName,
  );
  return reparented;
}
