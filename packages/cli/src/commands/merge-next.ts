import { DubError } from '../lib/errors';
import {
  checkGhAuth,
  ensureGhInstalled,
  getPr,
  mergePr,
  retargetPrBase,
} from '../lib/github';
import { type PostMergeResult, postMerge } from './post-merge';
import { getSubmitPlan } from './submit';

export interface MergeNextResult {
  dryRun: boolean;
  mergedBranch: string;
  prNumber: number;
  preMergeRetargeted: string[];
  postMerge?: PostMergeResult;
}

export async function mergeNext(
  cwd: string,
  options: {
    dryRun?: boolean;
    method?: 'merge' | 'squash' | 'rebase';
    restack?: boolean;
    submit?: boolean;
  } = {},
): Promise<MergeNextResult> {
  await ensureGhInstalled();
  await checkGhAuth();

  const plan = await getSubmitPlan(cwd, { path: 'current', fix: true });
  const nextBranch = plan.branches[0]?.name;
  if (!nextBranch) {
    throw new DubError(
      'No mergeable branch found in the current path. Check out a non-root stack branch first.',
    );
  }

  const pr = await getPr(nextBranch, cwd);
  if (!pr) {
    throw new DubError(
      `No open PR found for '${nextBranch}'. Run 'dub ss --path current' first.`,
    );
  }
  const nextEntry = plan.stack.branches.find(
    (branch) => branch.name === nextBranch,
  );
  const nextParent = nextEntry?.parent;
  if (!nextParent) {
    throw new DubError(
      `Branch '${nextBranch}' has no tracked parent. Run 'dub track ${nextBranch} --parent <branch>' first.`,
    );
  }
  const directChildren = plan.stack.branches
    .filter((branch) => branch.type !== 'root' && branch.parent === nextBranch)
    .map((branch) => branch.name)
    .sort();
  const childBranchesWithOpenPr: string[] = [];
  for (const childBranch of directChildren) {
    const childPr = await getPr(childBranch, cwd);
    if (childPr) {
      childBranchesWithOpenPr.push(childBranch);
    }
  }

  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    return {
      dryRun: true,
      mergedBranch: nextBranch,
      prNumber: pr.number,
      preMergeRetargeted: childBranchesWithOpenPr,
    };
  }

  for (const childBranch of childBranchesWithOpenPr) {
    await retargetPrBase(childBranch, nextParent, cwd);
  }
  await mergePr(pr.number, cwd, {
    method: options.method ?? 'squash',
    deleteBranch: true,
  });
  const maintenance = await postMerge(cwd, {
    dryRun: false,
    restack: options.restack ?? true,
    submit: options.submit ?? true,
  });
  return {
    dryRun: false,
    mergedBranch: nextBranch,
    prNumber: pr.number,
    preMergeRetargeted: childBranchesWithOpenPr,
    postMerge: maintenance,
  };
}
