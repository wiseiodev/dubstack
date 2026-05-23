import type { BranchPrLifecycleState } from '../github';

export type CleanupReason =
  | 'merged-pr'
  | 'closed-pr-merged-into-trunk'
  | 'merged-by-patch-id';

export interface CleanupPlan {
  toDelete: Array<{
    branch: string;
    reason: CleanupReason;
  }>;
  skipped: Array<{ branch: string; reason: string }>;
}

export async function buildCleanupPlan(input: {
  branches: string[];
  getPrStatus: (branch: string) => Promise<BranchPrLifecycleState>;
  isMergedIntoAnyRoot: (branch: string) => Promise<boolean>;
  isMergedByPatchId?: (branch: string) => Promise<boolean>;
}): Promise<CleanupPlan> {
  const toDelete: CleanupPlan['toDelete'] = [];
  const skipped: Array<{ branch: string; reason: string }> = [];

  for (const branch of input.branches) {
    const prState = await input.getPrStatus(branch);
    if (prState === 'MERGED') {
      // Squash/rebase merge strategies may not preserve branch commit ancestry,
      // but a merged PR still means the change is integrated and branch is cleanable.
      toDelete.push({ branch, reason: 'merged-pr' });
      continue;
    }

    if (prState === 'CLOSED') {
      const mergedIntoRoot = await input.isMergedIntoAnyRoot(branch);
      if (!mergedIntoRoot) {
        skipped.push({ branch, reason: 'commits-not-in-trunk' });
        continue;
      }
      toDelete.push({ branch, reason: 'closed-pr-merged-into-trunk' });
      continue;
    }

    if (prState === 'NONE' && input.isMergedByPatchId) {
      // No PR metadata available (e.g. branch imported from another machine).
      // Fall back to patch-id detection so squash/rebase merges still get cleaned up.
      if (await input.isMergedByPatchId(branch)) {
        toDelete.push({ branch, reason: 'merged-by-patch-id' });
      }
    }
  }

  return { toDelete, skipped };
}
