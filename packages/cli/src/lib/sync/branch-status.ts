import type { BranchSyncStatus } from './types';

export interface ClassifyBranchSyncStatusInput {
  hasRemote: boolean;
  hasLocal: boolean;
  localSha: string | null;
  remoteSha: string | null;
  localBehind: boolean;
  remoteBehind: boolean;
  hasSubmittedBaseline?: boolean;
  /** True if the tracked parent branch has a MERGED PR. */
  parentPrMerged?: boolean;
  /** PR `baseRefName` reported by the remote PR (if any). */
  remoteBaseRefName?: string | null;
  /** Locally tracked parent branch name. */
  localParent?: string | null;
  /**
   * True if `origin/<remoteBaseRefName>` is an ancestor of `origin/<branch>`
   * (remote was rebased onto a new parent that already exists upstream).
   */
  remoteContainsNewParentHistory?: boolean;
  /** True if PR is MERGED but the branch has local commits past the squash boundary. */
  squashMergedWithTrailingCommits?: boolean;
  /** Result of attempting a rebase of local onto remote (true == clean, false == conflicts). */
  rebaseOntoRemoteClean?: boolean | null;
}

export function classifyBranchSyncStatus(
  input: ClassifyBranchSyncStatusInput,
): BranchSyncStatus {
  if (!input.hasRemote) return 'missing-remote';
  if (!input.hasLocal) return 'missing-local';

  // These flags trump SHA equality: a squash-merged branch with trailing
  // local commits still needs cleanup, and a parent-merged orphan still needs
  // reparenting even when the child happens to match its remote tip.
  if (input.squashMergedWithTrailingCommits) {
    return 'squash-merged-with-trailing-commits';
  }
  if (input.parentPrMerged) {
    return 'parent-merged-orphan';
  }

  if (input.localSha && input.remoteSha && input.localSha === input.remoteSha) {
    if (!input.hasSubmittedBaseline) {
      return 'updated-outside-dubstack-but-up-to-date';
    }
    return 'up-to-date';
  }

  if (!input.hasSubmittedBaseline) return 'unsubmitted';
  if (input.localBehind) return 'needs-remote-sync-safe';
  if (input.remoteBehind) return 'local-ahead';

  // Diverged from here on.
  const remoteParentDiffers =
    input.remoteBaseRefName != null &&
    input.localParent != null &&
    input.remoteBaseRefName !== input.localParent;

  if (remoteParentDiffers && input.remoteContainsNewParentHistory) {
    return 'remote-restacked';
  }

  if (input.rebaseOntoRemoteClean === true) {
    return 'non-conflicting-divergence';
  }

  return 'reconcile-needed';
}
