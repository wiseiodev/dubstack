import type { BranchSyncStatus } from './types';

export function classifyBranchSyncStatus(input: {
  hasRemote: boolean;
  hasLocal: boolean;
  localSha: string | null;
  remoteSha: string | null;
  localBehind: boolean;
  remoteBehind: boolean;
  hasSubmittedBaseline?: boolean;
}): BranchSyncStatus {
  if (!input.hasRemote) return 'missing-remote';
  if (!input.hasLocal) return 'missing-local';

  if (input.localSha && input.remoteSha && input.localSha === input.remoteSha) {
    if (!input.hasSubmittedBaseline) {
      return 'updated-outside-dubstack-but-up-to-date';
    }
    return 'up-to-date';
  }

  if (!input.hasSubmittedBaseline) return 'unsubmitted';
  if (input.localBehind) return 'needs-remote-sync-safe';
  if (input.remoteBehind) return 'local-ahead';
  return 'reconcile-needed';
}
