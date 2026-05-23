import type { Branch } from '../state';

/** Branches synced within this window are reused without a network fetch. */
export const FRESH_SYNC_WINDOW_MS = 5 * 60 * 1000;

export interface FreshPartitionInput {
  branches: string[];
  branchMap: Map<string, Branch>;
  fresh: boolean;
  now: number;
  windowMs?: number;
}

export interface FreshPartition {
  mustFetch: string[];
  canSkip: string[];
}

/**
 * Splits a branch list into branches that need a fresh `git fetch`
 * and branches that can reuse their cached remote ref because they
 * were synced within the freshness window.
 *
 * Trunk handling is intentionally out of scope — callers must keep
 * trunks in `mustFetch` since trunk is the most volatile ref.
 */
export function partitionFreshBranches(
  input: FreshPartitionInput,
): FreshPartition {
  const windowMs = input.windowMs ?? FRESH_SYNC_WINDOW_MS;
  if (input.fresh) {
    return { mustFetch: [...input.branches], canSkip: [] };
  }
  const mustFetch: string[] = [];
  const canSkip: string[] = [];
  for (const branch of input.branches) {
    const entry = input.branchMap.get(branch);
    const lastSyncedAt = entry?.last_synced_at;
    if (!lastSyncedAt) {
      mustFetch.push(branch);
      continue;
    }
    const syncedAtMs = Date.parse(lastSyncedAt);
    if (
      Number.isNaN(syncedAtMs) ||
      input.now - syncedAtMs >= windowMs ||
      syncedAtMs > input.now
    ) {
      mustFetch.push(branch);
    } else {
      canSkip.push(branch);
    }
  }
  return { mustFetch, canSkip };
}
