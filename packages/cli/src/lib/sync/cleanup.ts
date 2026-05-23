import type { BranchPrLifecycleState } from '../github';

export type CleanupReason =
  | 'merged-pr'
  | 'merged-pr-with-trailing-commits'
  | 'closed-pr-merged-into-trunk'
  | 'merged-by-patch-id'
  /** Branch has zero unique commits relative to its parent. */
  | 'empty-branch';

export interface CleanupDeleteOp {
  type: 'delete';
  branch: string;
  reason: CleanupReason;
}

export interface CleanupReparentOp {
  type: 'reparent';
  branch: string;
  oldParent: string | null;
  newParent: string | null;
}

export type CleanupOperation = CleanupDeleteOp | CleanupReparentOp;

export interface CleanupPlan {
  /** Ordered list of operations to apply (deletes + reparents). */
  operations: CleanupOperation[];
  /** Branches that should be deleted, in deletion order. */
  toDelete: Array<{ branch: string; reason: CleanupReason }>;
  /** Re-parent operations applied to non-deletable orphans, in order. */
  toReparent: Array<{
    branch: string;
    oldParent: string | null;
    newParent: string | null;
  }>;
  /** Branches we considered but won't touch, with a human-readable reason. */
  skipped: Array<{ branch: string; reason: string }>;
}

export interface BuildCleanupPlanInput {
  /** All non-root branches under consideration. */
  branches: string[];
  getPrStatus: (branch: string) => Promise<BranchPrLifecycleState>;
  isMergedIntoAnyRoot: (branch: string) => Promise<boolean>;
  isMergedByPatchId?: (branch: string) => Promise<boolean>;
  /**
   * Branch name -> parent branch name (or null for trunk-rooted).
   * If omitted, the algorithm runs in flat mode: no DFS, no re-parenting.
   */
  parentOf?: Map<string, string | null>;
  /**
   * Returns true if `branch` has zero unique commits relative to `parent`.
   * Used to detect empty-with-PR branches.
   */
  isEmpty?: (branch: string, parent: string | null) => Promise<boolean>;
  /** Bypass the empty-branch-no-PR safety rule (`--force`). */
  force?: boolean;
}

/**
 * Build a cleanup plan using DFS-greedy with eager re-parenting.
 *
 * The algorithm (adapted from Graphite's `clean_branches.ts`):
 * - Process direct children of trunk in DFS order.
 * - If a branch is deletable, queue its children and defer deletion until all
 *   its child-blockers are themselves deletable (greedy bottom-up).
 * - If a branch is not deletable but its parent is in the pending-delete set,
 *   re-parent it onto the nearest non-deleted ancestor.
 *
 * When `parentOf` is omitted, the algorithm degenerates to a flat scan that
 * matches the prior cleanup behavior for backwards compatibility.
 */
export async function buildCleanupPlan(
  input: BuildCleanupPlanInput,
): Promise<CleanupPlan> {
  const tracked = new Set(input.branches);
  const parentOf = new Map<string, string | null>();
  for (const branch of input.branches) {
    parentOf.set(branch, input.parentOf?.get(branch) ?? null);
  }

  const childrenOf = new Map<string, string[]>();
  for (const branch of input.branches) {
    const parent = parentOf.get(branch) ?? null;
    if (parent != null && tracked.has(parent)) {
      const arr = childrenOf.get(parent) ?? [];
      arr.push(branch);
      childrenOf.set(parent, arr);
    }
  }

  // DFS-greedy starts at branches whose parent is not tracked (effectively
  // children of trunk). In flat mode (no parentOf) every branch qualifies.
  const queue: string[] = [];
  for (const branch of input.branches) {
    const parent = parentOf.get(branch) ?? null;
    if (parent == null || !tracked.has(parent)) {
      queue.push(branch);
    }
  }

  const operations: CleanupOperation[] = [];
  const skipped: Array<{ branch: string; reason: string }> = [];
  const visited = new Set<string>();
  const deleted = new Set<string>();
  const pendingDelete = new Map<
    string,
    { reason: CleanupReason; blockers: Set<string> }
  >();
  const skippedSeen = new Set<string>();

  // Cache PR status calls — getDeleteReason may be invoked twice per branch
  // (once for the delete check, once to surface the skip reason).
  const prStatusCache = new Map<string, BranchPrLifecycleState>();
  async function getPrStatus(branch: string): Promise<BranchPrLifecycleState> {
    let cached = prStatusCache.get(branch);
    if (cached === undefined) {
      cached = await input.getPrStatus(branch);
      prStatusCache.set(branch, cached);
    }
    return cached;
  }

  async function getDeleteReason(
    branch: string,
  ): Promise<CleanupReason | null> {
    const prState = await getPrStatus(branch);
    if (prState === 'MERGED') {
      let reason: CleanupReason = 'merged-pr';
      if (input.isMergedByPatchId) {
        const allInTrunk = await input.isMergedByPatchId(branch);
        if (!allInTrunk) reason = 'merged-pr-with-trailing-commits';
      }
      return reason;
    }
    if (prState === 'CLOSED') {
      const mergedIntoRoot = await input.isMergedIntoAnyRoot(branch);
      if (mergedIntoRoot) return 'closed-pr-merged-into-trunk';
      return null;
    }
    if (prState === 'OPEN') {
      // An empty branch *with* a PR is safe to clean up: the PR has nothing
      // to ship, and keeping it around just clutters the stack.
      if (input.isEmpty) {
        const parent = parentOf.get(branch) ?? null;
        if (await input.isEmpty(branch, parent)) return 'empty-branch';
      }
      return null;
    }
    // NONE: no PR metadata. Fall back to patch-id detection if available.
    // The empty-branch safety rule keeps NONE+empty branches around unless
    // `--force` is set, since users may rely on them as placeholders.
    if (input.isMergedByPatchId && (await input.isMergedByPatchId(branch))) {
      return 'merged-by-patch-id';
    }
    if (input.force && input.isEmpty) {
      const parent = parentOf.get(branch) ?? null;
      if (await input.isEmpty(branch, parent)) return 'empty-branch';
    }
    return null;
  }

  function recordSkipOnce(branch: string, reason: string): void {
    if (skippedSeen.has(branch)) return;
    skippedSeen.add(branch);
    skipped.push({ branch, reason });
  }

  function walkUpToNonDeleted(branch: string): string | null {
    let p = parentOf.get(branch) ?? null;
    while (p != null && (deleted.has(p) || pendingDelete.has(p))) {
      const next = parentOf.get(p) ?? null;
      p = next;
    }
    return p;
  }

  function greedilyDeleteUnblocked(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [branch, info] of [...pendingDelete.entries()]) {
        if (info.blockers.size > 0) continue;
        operations.push({ type: 'delete', branch, reason: info.reason });
        deleted.add(branch);
        pendingDelete.delete(branch);
        const par = parentOf.get(branch) ?? null;
        if (par != null) {
          const parentEntry = pendingDelete.get(par);
          if (parentEntry) parentEntry.blockers.delete(branch);
        }
        changed = true;
      }
    }
  }

  while (queue.length > 0) {
    const branch = queue.shift();
    if (branch == null) break;
    if (visited.has(branch) || deleted.has(branch)) continue;

    const reason = await getDeleteReason(branch);
    if (reason != null) {
      visited.add(branch);
      const liveChildren = (childrenOf.get(branch) ?? []).filter(
        (c) => !deleted.has(c),
      );
      pendingDelete.set(branch, {
        reason,
        blockers: new Set(liveChildren),
      });
      // DFS: enqueue children to the front so they're processed before
      // any pending siblings of `branch`.
      for (let i = liveChildren.length - 1; i >= 0; i--) {
        const child = liveChildren[i];
        if (!visited.has(child) && !deleted.has(child)) {
          queue.unshift(child);
        }
      }
      greedilyDeleteUnblocked();
      continue;
    }

    // Not deletable. Record skip-reason for known cases (CLOSED-not-in-trunk).
    const prState = await getPrStatus(branch);
    if (prState === 'CLOSED') {
      recordSkipOnce(branch, 'commits-not-in-trunk');
    }

    const oldParent = parentOf.get(branch) ?? null;
    const ancestor = walkUpToNonDeleted(branch);
    if (ancestor !== oldParent) {
      operations.push({
        type: 'reparent',
        branch,
        oldParent,
        newParent: ancestor,
      });
      parentOf.set(branch, ancestor);
      // Re-parenting away from a pending-delete parent removes that branch
      // as a blocker so the parent can be eagerly deleted.
      if (oldParent != null) {
        const parentEntry = pendingDelete.get(oldParent);
        if (parentEntry) {
          parentEntry.blockers.delete(branch);
          greedilyDeleteUnblocked();
        }
      }
      // Re-evaluate the branch at its new position: getDeleteReason may
      // return a different answer once the parent changed (e.g. empty-with-pr).
      queue.push(branch);
      continue;
    }

    visited.add(branch);
  }

  // Flush any pending deletes whose blockers were never resolved. In a
  // well-formed tree this is empty, but it acts as a safety net for branches
  // whose blockers got stuck (e.g. detection failed for one child).
  greedilyDeleteUnblocked();

  const toDelete = operations.filter(
    (op): op is CleanupDeleteOp => op.type === 'delete',
  );
  const toReparent = operations
    .filter((op): op is CleanupReparentOp => op.type === 'reparent')
    .map(({ branch, oldParent, newParent }) => ({
      branch,
      oldParent,
      newParent,
    }));

  return {
    operations,
    toDelete: toDelete.map(({ branch, reason }) => ({ branch, reason })),
    toReparent,
    skipped,
  };
}
