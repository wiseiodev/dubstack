import type { BranchPrLifecycleState } from '../github';

export interface CleanupPlan {
  toDelete: Array<{
    branch: string;
    reason: 'merged-pr' | 'closed-pr-merged-into-trunk';
  }>;
  skipped: Array<{ branch: string; reason: string }>;
}

export async function buildCleanupPlan(input: {
  branches: string[];
  getPrStatus: (branch: string) => Promise<BranchPrLifecycleState>;
  isMergedIntoAnyRoot: (branch: string) => Promise<boolean>;
}): Promise<CleanupPlan> {
  const toDelete: Array<{
    branch: string;
    reason: 'merged-pr' | 'closed-pr-merged-into-trunk';
  }> = [];
  const skipped: Array<{ branch: string; reason: string }> = [];

  for (const branch of input.branches) {
    const prState = await input.getPrStatus(branch);
    if (prState === 'MERGED') {
      // Squash/rebase merge strategies may not preserve branch commit ancestry,
      // but a merged PR still means the change is integrated and branch is cleanable.
      toDelete.push({ branch, reason: 'merged-pr' });
      continue;
    }
    if (prState !== 'CLOSED') {
      continue;
    }

    const mergedIntoRoot = await input.isMergedIntoAnyRoot(branch);
    if (!mergedIntoRoot) {
      skipped.push({ branch, reason: 'commits-not-in-trunk' });
      continue;
    }

    toDelete.push({ branch, reason: 'closed-pr-merged-into-trunk' });
  }

  return { toDelete, skipped };
}
