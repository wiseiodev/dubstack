import { describe, expect, it } from 'vitest';
import { classifyBranchSyncStatus } from './branch-status';

describe('classifyBranchSyncStatus', () => {
  it('returns missing-remote when no remote exists', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: false,
        hasLocal: true,
        localSha: 'a',
        remoteSha: null,
        localBehind: false,
        remoteBehind: false,
      }),
    ).toBe('missing-remote');
  });

  it('returns missing-local when local branch is absent', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: false,
        localSha: null,
        remoteSha: 'a',
        localBehind: false,
        remoteBehind: false,
      }),
    ).toBe('missing-local');
  });

  it('returns up-to-date when SHAs match', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'a',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
      }),
    ).toBe('up-to-date');
  });

  it('returns updated-outside-dubstack-but-up-to-date without baseline', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'a',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: false,
      }),
    ).toBe('updated-outside-dubstack-but-up-to-date');
  });

  it('returns needs-remote-sync-safe when local is behind', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: true,
        remoteBehind: false,
        hasSubmittedBaseline: true,
      }),
    ).toBe('needs-remote-sync-safe');
  });

  it('returns local-ahead when remote is behind', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'b',
        remoteSha: 'a',
        localBehind: false,
        remoteBehind: true,
        hasSubmittedBaseline: true,
      }),
    ).toBe('local-ahead');
  });

  it('returns unsubmitted when divergent and no baseline', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: false,
      }),
    ).toBe('unsubmitted');
  });

  it('returns reconcile-needed when branches diverged', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
      }),
    ).toBe('reconcile-needed');
  });

  it('returns squash-merged-with-trailing-commits when the flag is set', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
        squashMergedWithTrailingCommits: true,
      }),
    ).toBe('squash-merged-with-trailing-commits');
  });

  it('returns parent-merged-orphan when tracked parent PR merged', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
        parentPrMerged: true,
      }),
    ).toBe('parent-merged-orphan');
  });

  it('returns remote-restacked when remote parent moved and contains new history', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
        localParent: 'main',
        remoteBaseRefName: 'new-parent',
        remoteContainsNewParentHistory: true,
      }),
    ).toBe('remote-restacked');
  });

  it('returns non-conflicting-divergence when rebase trial is clean', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
        rebaseOntoRemoteClean: true,
      }),
    ).toBe('non-conflicting-divergence');
  });

  it('stays on reconcile-needed when rebase trial is null/false', () => {
    expect(
      classifyBranchSyncStatus({
        hasRemote: true,
        hasLocal: true,
        localSha: 'a',
        remoteSha: 'b',
        localBehind: false,
        remoteBehind: false,
        hasSubmittedBaseline: true,
        rebaseOntoRemoteClean: false,
      }),
    ).toBe('reconcile-needed');
  });
});
