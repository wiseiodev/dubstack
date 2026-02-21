import { DubError } from '../lib/errors';
import { checkGhAuth, ensureGhInstalled, getPr, mergePr } from '../lib/github';
import { type PostMergeResult, postMerge } from './post-merge';
import { getSubmitPlan } from './submit';

export interface MergeNextResult {
  dryRun: boolean;
  mergedBranch: string;
  prNumber: number;
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

  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    return {
      dryRun: true,
      mergedBranch: nextBranch,
      prNumber: pr.number,
    };
  }

  await mergePr(pr.number, cwd, {
    method: options.method ?? 'merge',
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
    postMerge: maintenance,
  };
}
