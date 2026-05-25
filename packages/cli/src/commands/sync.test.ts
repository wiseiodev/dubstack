import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DubError } from '../lib/errors';

vi.mock('../lib/git.js', () => ({
  branchExists: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  clearStaleNamespacedFetchRefs: vi.fn(),
  deleteBranch: vi.fn(),
  fastForwardBranchToRef: vi.fn(),
  fetchBranches: vi.fn(),
  formatWorktreeCheckoutSkipMessage: vi.fn(
    (branch: string, worktreePath: string, command = 'dub sync') =>
      `ℹ Skipped '${branch}' — checked out in ${worktreePath}.\n   Run \`${command}\` from that worktree to update it.`,
  ),
  getCurrentBranch: vi.fn(),
  getRefSha: vi.fn(),
  hardResetBranchToRef: vi.fn(),
  hasUniquePatchCommits: vi.fn().mockResolvedValue(true),
  isAncestor: vi.fn(),
  listWorktreeCheckouts: vi.fn(),
  pruneRemote: vi.fn(),
  rebaseBranchOntoRef: vi.fn(),
  remoteBranchExists: vi.fn(),
}));

vi.mock('../lib/cleanup-journal.js', () => ({
  startCleanupJournal: vi.fn().mockResolvedValue({
    version: 1,
    started_at: 'mock',
    operations: [],
  }),
  appendCleanupOperation: vi.fn().mockResolvedValue(undefined),
  clearCleanupJournal: vi.fn().mockResolvedValue(undefined),
  hasCleanupJournal: vi.fn().mockResolvedValue(false),
  readCleanupJournal: vi.fn().mockResolvedValue(null),
  getCleanupJournalPath: vi.fn().mockResolvedValue('/tmp/journal.json'),
  CLEANUP_JOURNAL_FILENAME: 'cleanup-journal.json',
}));

vi.mock('../lib/git/is-merged-by-patch-id.js', () => ({
  isMergedByPatchId: vi.fn(),
}));

vi.mock('../lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state.js')>();
  return {
    ...actual,
    readState: vi.fn(),
    writeState: vi.fn(),
  };
});

vi.mock('./restack.js', () => ({
  restack: vi.fn(),
}));

vi.mock('../lib/restack-conflict-prompt.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/restack-conflict-prompt.js')>();
  return {
    ...actual,
    restackConflictPrompt: vi.fn(),
  };
});

vi.mock('../lib/restack-rollback.js', () => ({
  rollbackRestack: vi.fn(),
}));

vi.mock('../lib/operation-state.js', () => ({
  detectActiveOperation: vi.fn(),
}));

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getAllPrSyncInfoBatch: vi.fn(),
  getBranchPrLifecycleState: vi.fn(),
  getBranchPrSyncInfo: vi.fn(),
  retargetPrBase: vi.fn(),
}));

import {
  branchExists,
  checkoutBranch,
  checkoutRemoteBranch,
  clearStaleNamespacedFetchRefs,
  deleteBranch,
  fastForwardBranchToRef,
  fetchBranches,
  getCurrentBranch,
  getRefSha,
  hardResetBranchToRef,
  isAncestor,
  listWorktreeCheckouts,
  pruneRemote,
  rebaseBranchOntoRef,
  remoteBranchExists,
} from '../lib/git';
import { isMergedByPatchId } from '../lib/git/is-merged-by-patch-id';
import {
  checkGhAuth,
  ensureGhInstalled,
  getAllPrSyncInfoBatch,
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import { detectActiveOperation } from '../lib/operation-state';
import { restackConflictPrompt } from '../lib/restack-conflict-prompt';
import { rollbackRestack } from '../lib/restack-rollback';
import type { DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { doctor } from './doctor';
import { restack } from './restack';
import { submit } from './submit';
import { sync } from './sync';

vi.mock('./submit.js', () => ({
  submit: vi.fn(),
}));

const mockBranchExists = branchExists as ReturnType<typeof vi.fn>;
const mockCheckoutBranch = checkoutBranch as ReturnType<typeof vi.fn>;
const mockCheckoutRemoteBranch = checkoutRemoteBranch as ReturnType<
  typeof vi.fn
>;
const mockDeleteBranch = deleteBranch as ReturnType<typeof vi.fn>;
const mockFastForwardBranchToRef = fastForwardBranchToRef as ReturnType<
  typeof vi.fn
>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockClearStaleNamespacedFetchRefs =
  clearStaleNamespacedFetchRefs as ReturnType<typeof vi.fn>;
const mockPruneRemote = pruneRemote as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetRefSha = getRefSha as ReturnType<typeof vi.fn>;
const mockHardResetBranchToRef = hardResetBranchToRef as ReturnType<
  typeof vi.fn
>;
const mockIsAncestor = isAncestor as ReturnType<typeof vi.fn>;
const mockListWorktreeCheckouts = listWorktreeCheckouts as ReturnType<
  typeof vi.fn
>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockRebaseBranchOntoRef = rebaseBranchOntoRef as ReturnType<typeof vi.fn>;
const mockIsMergedByPatchId = isMergedByPatchId as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockRestack = restack as ReturnType<typeof vi.fn>;
const mockDetectActiveOperation = detectActiveOperation as ReturnType<
  typeof vi.fn
>;
const mockGetBranchPrLifecycleState = getBranchPrLifecycleState as ReturnType<
  typeof vi.fn
>;
const mockGetBranchPrSyncInfo = getBranchPrSyncInfo as ReturnType<typeof vi.fn>;
const mockGetAllPrSyncInfoBatch = getAllPrSyncInfoBatch as ReturnType<
  typeof vi.fn
>;
const mockRetargetPrBase = retargetPrBase as ReturnType<typeof vi.fn>;
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockSubmit = submit as ReturnType<typeof vi.fn>;
const mockRestackConflictPrompt = restackConflictPrompt as ReturnType<
  typeof vi.fn
>;
const mockRollbackRestack = rollbackRestack as ReturnType<typeof vi.fn>;

function makeState(
  branches: {
    name: string;
    parent: string | null;
    type?: 'root';
    frozen?: boolean;
  }[],
): DubState {
  return {
    stacks: [
      {
        id: 'stack-1',
        branches: branches.map((b) => ({
          ...b,
          pr_number: null,
          pr_link: null,
          last_submitted_version:
            b.type === 'root'
              ? null
              : {
                  head_sha: `${b.name}-sha`,
                  base_sha: `${b.parent ?? 'main'}-sha`,
                  base_branch: b.parent ?? 'main',
                  version_number: null,
                  source: 'submit',
                },
          last_synced_at: null,
          sync_source: b.type === 'root' ? null : 'submit',
        })),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentBranch.mockResolvedValue('feat/a');
  mockFetchBranches.mockResolvedValue(undefined);
  mockClearStaleNamespacedFetchRefs.mockResolvedValue([]);
  mockPruneRemote.mockResolvedValue(undefined);
  mockFastForwardBranchToRef.mockResolvedValue(true);
  mockBranchExists.mockResolvedValue(true);
  mockRemoteBranchExists.mockResolvedValue(true);
  mockGetRefSha.mockImplementation(async (ref: string) => `${ref}-sha`);
  mockIsAncestor.mockResolvedValue(false);
  mockHardResetBranchToRef.mockResolvedValue(undefined);
  mockRebaseBranchOntoRef.mockResolvedValue(false);
  mockIsMergedByPatchId.mockResolvedValue(true);
  mockListWorktreeCheckouts.mockResolvedValue(new Map());
  mockCheckoutRemoteBranch.mockResolvedValue(undefined);
  mockCheckoutBranch.mockResolvedValue(undefined);
  mockDeleteBranch.mockResolvedValue(undefined);
  mockRestack.mockResolvedValue({ status: 'up-to-date', rebased: [] });
  mockGetBranchPrLifecycleState.mockResolvedValue('OPEN');
  mockGetBranchPrSyncInfo.mockResolvedValue({
    state: 'OPEN',
    baseRefName: 'main',
  });
  // Default: empty batch flagged as truncated so existing tests exercise the
  // per-branch fallback (preserving prior mock-based expectations).
  mockGetAllPrSyncInfoBatch.mockResolvedValue({
    byBranch: new Map(),
    truncated: true,
  });
  mockRetargetPrBase.mockResolvedValue(undefined);
  mockDetectActiveOperation.mockResolvedValue('none');
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockWriteState.mockResolvedValue(undefined);
  mockSubmit.mockResolvedValue({
    pushed: ['feat/a'],
    created: [],
    updated: ['feat/a'],
    scope: { kind: 'downstack' },
    dryRun: false,
  });
});

describe('sync', () => {
  it('throws when current branch is not tracked and --all is false', async () => {
    mockReadState.mockResolvedValue({ stacks: [] });
    await expect(sync('/repo', { interactive: false })).rejects.toThrow(
      'not part of any stack',
    );
  });

  it('fetches tracked branches and reports up-to-date branch', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await sync('/repo', { interactive: false, restack: false });

    expect(mockEnsureGhInstalled).toHaveBeenCalledTimes(1);
    expect(mockCheckGhAuth).toHaveBeenCalledTimes(1);
    expect(mockFetchBranches).toHaveBeenCalledWith(
      ['main', 'feat/a'],
      '/repo',
      'origin',
      expect.objectContaining({ onBranchStart: expect.any(Function) }),
    );
    expect(result.fetched).toEqual(['main', 'feat/a']);
    expect(result.branches[0].status).toBe('up-to-date');
    expect(mockRestack).not.toHaveBeenCalled();
  });

  it('skips reconciliation for branches checked out in another worktree', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockListWorktreeCheckouts.mockResolvedValue(
      new Map([['feat/a', '/repo-worktree']]),
    );

    const result = await sync('/repo', { interactive: false, restack: false });

    expect(result.branches).toEqual([
      {
        branch: 'feat/a',
        status: 'checked-out-elsewhere',
        action: 'skipped',
        message:
          "ℹ Skipped 'feat/a' — checked out in /repo-worktree.\n   Run `dub sync` from that worktree to update it.",
      },
    ]);
    expect(mockHardResetBranchToRef).not.toHaveBeenCalledWith(
      'feat/a',
      expect.any(String),
      '/repo',
    );
  });

  it('clears stale namespaced fetch refs and prunes remote once before trunk pull', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const callOrder: string[] = [];
    mockClearStaleNamespacedFetchRefs.mockImplementation(async () => {
      callOrder.push('clearStale');
      return [];
    });
    mockFetchBranches.mockImplementation(async () => {
      callOrder.push('fetch');
    });
    mockPruneRemote.mockImplementation(async () => {
      callOrder.push('prune');
    });
    mockFastForwardBranchToRef.mockImplementation(async (branch: string) => {
      callOrder.push(`ff:${branch}`);
      return true;
    });

    await sync('/repo', { interactive: false, restack: false });

    expect(mockClearStaleNamespacedFetchRefs).toHaveBeenCalledTimes(1);
    const [keepArg] = mockClearStaleNamespacedFetchRefs.mock.calls[0];
    expect([...(keepArg as Set<string>)].sort()).toEqual(
      ['feat/a', 'feat/b', 'main'].sort(),
    );
    expect(mockPruneRemote).toHaveBeenCalledTimes(1);
    expect(mockPruneRemote).toHaveBeenCalledWith('origin', '/repo');
    expect(callOrder.indexOf('clearStale')).toBeLessThan(
      callOrder.indexOf('fetch'),
    );
    expect(callOrder.indexOf('prune')).toBeLessThan(
      callOrder.indexOf('ff:main'),
    );
  });

  it('restacks by default', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await sync('/repo', { interactive: false });
    expect(result.restacked).toBe(true);
    expect(mockRestack).toHaveBeenCalled();
  });

  it('treats trunk fast-forward conflicts as resettable when --force is set', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockFastForwardBranchToRef.mockImplementation(
      async (branch: string) => branch !== 'main',
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    await sync('/repo', { interactive: false, force: true, restack: false });

    expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
      'main',
      'origin/main',
      '/repo',
    );
  });

  it('fails trunk sync immediately on non-conflict fast-forward errors', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockFastForwardBranchToRef.mockRejectedValue(
      new DubError(
        "Failed to checkout branch 'main'.\nYour local changes would be overwritten by checkout.",
      ),
    );

    await expect(
      sync('/repo', { interactive: false, restack: false }),
    ).rejects.toThrow("Failed to checkout branch 'main'.");
    expect(mockHardResetBranchToRef).not.toHaveBeenCalledWith(
      'main',
      'origin/main',
      '/repo',
    );
  });

  it('restores missing local branch from remote', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockBranchExists.mockImplementation(
      async (name: string) => name === 'main',
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await sync('/repo', { interactive: false, restack: false });

    expect(mockCheckoutRemoteBranch).toHaveBeenCalledWith('feat/a', '/repo');
    expect(result.branches[0].status).toBe('missing-local');
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    expect(
      writtenState.stacks[0].branches.find((b) => b.name === 'feat/a')
        ?.last_submitted_version?.base_branch,
    ).toBe('main');
  });

  it('hard-resets branch when local is safely behind remote', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-a')
      .mockResolvedValueOnce('remote-a');
    mockIsAncestor
      .mockResolvedValueOnce(true) // local behind remote
      .mockResolvedValueOnce(false);

    const result = await sync('/repo', { interactive: false, restack: false });

    expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
      'feat/a',
      'origin/feat/a',
      '/repo',
    );
    expect(result.branches[0].status).toBe('needs-remote-sync-safe');
  });

  it('surfaces branch reset root-cause details when sync reset fails', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-a')
      .mockResolvedValueOnce('remote-a');
    mockIsAncestor.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockHardResetBranchToRef.mockRejectedValue(
      new DubError(
        "Failed to hard reset 'feat/a' to 'origin/feat/a'.\nfatal: cannot lock ref",
      ),
    );

    await expect(
      sync('/repo', { interactive: false, restack: false }),
    ).rejects.toThrow(
      /Failed to hard reset 'feat\/a' to 'origin\/feat\/a'\.[\s\S]*cannot lock ref/,
    );
  });

  it('aborts on diverged branch in non-interactive mode without force (DUB-15)', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-a')
      .mockResolvedValueOnce('remote-a');
    mockIsAncestor.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    let captured: DubError | null = null;
    try {
      await sync('/repo', { interactive: false, restack: false });
    } catch (error) {
      captured = error as DubError;
    }

    expect(captured).toBeInstanceOf(DubError);
    expect(captured?.message).toContain(
      "Sync aborted while reconciling 'feat/a'",
    );
    expect(captured?.message).toContain('prompting is disabled');
    expect(captured?.recovery.length).toBeGreaterThan(0);
    expect(mockHardResetBranchToRef).not.toHaveBeenCalled();
  });

  it('forces diverged branch to remote with --force', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-a')
      .mockResolvedValueOnce('remote-a');
    mockIsAncestor.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await sync('/repo', {
      interactive: false,
      force: true,
      restack: false,
    });

    expect(result.branches[0].action).toBe('synced');
    expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
      'feat/a',
      'origin/feat/a',
      '/repo',
    );
  });

  it('classifies frozen branches as frozen-skipped and does not let --force mutate them', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main', frozen: true },
      ]),
    );
    const result = await sync('/repo', {
      interactive: false,
      force: true,
      restack: false,
    });

    expect(result.branches[0]).toMatchObject({
      branch: 'feat/a',
      status: 'frozen-skipped',
      action: 'skipped',
      reconcileSource: 'sync-skip',
    });
    expect(result.branches[0]?.message).toContain('dub unfreeze feat/a');
    expect(mockHardResetBranchToRef).not.toHaveBeenCalledWith(
      'feat/a',
      'origin/feat/a',
      '/repo',
    );
    expect(mockRemoteBranchExists).not.toHaveBeenCalledWith('feat/a', '/repo');
    expect(mockGetRefSha).not.toHaveBeenCalledWith('feat/a', '/repo');
  });

  it('short-circuits recently-synced frozen branches instead of treating them as fresh cache hits', async () => {
    const state = makeState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/a', parent: 'main', frozen: true },
    ]);
    const featA = state.stacks[0].branches.find((b) => b.name === 'feat/a');
    if (featA) featA.last_synced_at = new Date().toISOString();
    mockReadState.mockResolvedValue(state);
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await sync('/repo', { interactive: false, restack: false });

    expect(mockFetchBranches).toHaveBeenCalledWith(
      ['main'],
      '/repo',
      'origin',
      expect.objectContaining({ onBranchStart: expect.any(Function) }),
    );
    expect(result.branches[0]?.status).toBe('frozen-skipped');
  });

  it('classifies equal unmanaged branch as updated outside dubstack', async () => {
    mockReadState.mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
              last_submitted_version: null,
              last_synced_at: null,
              sync_source: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: null,
              pr_link: null,
              last_submitted_version: null,
              last_synced_at: null,
              sync_source: null,
            },
          ],
        },
      ],
    });
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await sync('/repo', { interactive: false, restack: false });
    expect(result.branches[0].status).toBe(
      'updated-outside-dubstack-but-up-to-date',
    );
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featA = writtenState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    expect(featA?.last_submitted_version?.source).toBe('imported');
    expect(featA?.sync_source).toBe('imported');
  });

  it('preserves existing provenance on no-op sync runs', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    await sync('/repo', { interactive: false, restack: false });

    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featA = writtenState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    expect(featA?.last_submitted_version?.source).toBe('submit');
    expect(featA?.sync_source).toBe('submit');
    expect(featA?.last_reconciled_version?.source).toBe('sync-no-change');
  });

  it('cleans merged branch automatically without force', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'MERGED',
      baseRefName: 'main',
    });

    const result = await sync('/repo', {
      interactive: false,
      restack: false,
    });

    expect(mockDeleteBranch).toHaveBeenCalledWith('feat/a', '/repo');
    expect(result.cleaned).toContain('feat/a');
    expect(result.branches).toHaveLength(0);
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    expect(
      writtenState.stacks[0].branches.find((b) => b.name === 'feat/a'),
    ).toBeUndefined();
  });

  it('skips auto-clean deletion for branches checked out in another worktree', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'MERGED',
      baseRefName: 'main',
    });
    mockListWorktreeCheckouts.mockResolvedValue(
      new Map([['feat/a', '/repo-worktree']]),
    );

    const result = await sync('/repo', {
      interactive: false,
      restack: false,
    });

    expect(mockDeleteBranch).not.toHaveBeenCalledWith('feat/a', '/repo');
    expect(result.cleaned).toEqual([]);
    expect(result.branches[0]?.status).toBe('checked-out-elsewhere');
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    expect(
      writtenState.stacks[0].branches.find((b) => b.name === 'feat/a'),
    ).toBeTruthy();
  });

  it('still reparents an excluded-from-sync child when its parent gets deleted', async () => {
    // trunk → feat/a (MERGED, will delete) → feat/b (CLOSED, commits not in
    // trunk → skipped + added to excludedFromSync). The reparent op for
    // feat/b must still apply or its `parent` would dangle on a now-deleted
    // ancestor.
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') return { state: 'MERGED', baseRefName: 'main' };
      if (branch === 'feat/b')
        return { state: 'CLOSED', baseRefName: 'feat/a' };
      return { state: 'NONE', baseRefName: null };
    });
    // CLOSED + not merged into any root → skipped + excluded.
    mockIsAncestor.mockResolvedValue(false);

    await sync('/repo', { interactive: false, restack: false });

    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featB = writtenState.stacks[0].branches.find(
      (b) => b.name === 'feat/b',
    );
    expect(featB?.parent).toBe('main');
    expect(
      writtenState.stacks[0].branches.find((b) => b.name === 'feat/a'),
    ).toBeUndefined();
  });

  it('warns when auto-cleaning a merged branch with dependent children', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => ({
      state: branch === 'feat/a' ? 'MERGED' : 'OPEN',
      baseRefName: branch === 'feat/a' ? 'main' : 'feat/a',
    }));
    const logSpy = vi.spyOn(console, 'log');

    try {
      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      expect(result.cleaned).toEqual(['feat/a']);
      expect(mockDeleteBranch).toHaveBeenCalledWith('feat/a', '/repo');
      const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
      expect(
        writtenState.stacks[0].branches.find((b) => b.name === 'feat/b')
          ?.parent,
      ).toBe('main');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Auto-clean deleting 'feat/a' (merged-pr) with dependent branch(es): feat/b",
        ),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('refreshes the surviving child branch after cleaning a merged parent while on trunk', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
        { name: 'feat/c', parent: 'feat/b' },
      ]),
    );
    // feat/c is up-to-date so it never enters the reconcile path
    mockGetRefSha.mockImplementation(async (ref: string) =>
      ref === 'feat/c' || ref === 'origin/feat/c' ? 'feat-c-sha' : `${ref}-sha`,
    );
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') {
        return { state: 'MERGED', baseRefName: 'main' };
      }
      if (branch === 'feat/b') {
        return { state: 'OPEN', baseRefName: 'feat/a' };
      }
      if (branch === 'feat/c') {
        return { state: 'OPEN', baseRefName: 'feat/b' };
      }
      return { state: 'NONE', baseRefName: null };
    });
    mockSubmit.mockImplementation(async (_cwd, _dryRun, options) => {
      const lastCheckout = mockCheckoutBranch.mock.calls.at(-1)?.[0];
      if (lastCheckout !== 'feat/b') {
        throw new Error(
          `expected surviving child checkout, got ${lastCheckout}`,
        );
      }
      if (options?.stack !== true) {
        throw new Error(
          `expected full-stack refresh, got ${JSON.stringify(options)}`,
        );
      }
      return {
        pushed: ['feat/b', 'feat/c'],
        created: [],
        updated: ['feat/b', 'feat/c'],
        scope: { kind: 'stack' },
        dryRun: false,
      };
    });

    await sync('/repo', { interactive: false, restack: false });

    expect(mockRetargetPrBase).toHaveBeenCalledWith('feat/b', 'main', '/repo');
    expect(mockSubmit).toHaveBeenCalledWith('/repo', false, {
      stack: true,
    });
    expect(mockCheckoutBranch).toHaveBeenCalledWith('feat/b', '/repo');
  });

  it('preserves parent_revision when auto-cleaning reparents children', async () => {
    mockReadState.mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
              last_submitted_version: null,
              last_synced_at: null,
              sync_source: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'feat/a-sha',
                base_sha: 'main-sha',
                base_branch: 'main',
                version_number: null,
                source: 'submit',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              parent_revision: 'a-tip-sha-original',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'feat/b-sha',
                base_sha: 'feat/a-sha',
                base_branch: 'feat/a',
                version_number: null,
                source: 'submit',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
          ],
        },
      ],
    });
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => ({
      state: branch === 'feat/a' ? 'MERGED' : 'OPEN',
      baseRefName: branch === 'feat/a' ? 'main' : 'feat/a',
    }));

    const result = await sync('/repo', {
      interactive: false,
      restack: false,
    });

    expect(result.cleaned).toContain('feat/a');
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featB = writtenState.stacks[0].branches.find(
      (b) => b.name === 'feat/b',
    );
    expect(featB?.parent).toBe('main');
    expect(featB?.parent_revision).toBe('a-tip-sha-original');
  });

  it('updates parent_revision via markBranchSynced when base is ancestor', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockIsAncestor.mockResolvedValue(true);

    await sync('/repo', { interactive: false, restack: false });

    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featA = writtenState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    expect(featA?.parent_revision).toBe('same-sha');
    expect(featA?.last_reconciled_version).toEqual({
      head_sha: 'same-sha',
      base_sha: 'same-sha',
      base_branch: 'main',
      source: 'sync-no-change',
    });
  });

  it('preserves the last submitted base sha when forced sync adopts an older remote child tip', async () => {
    mockReadState.mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
              last_submitted_version: null,
              last_synced_at: null,
              sync_source: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              parent_revision: 'main-sha',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'parent-new-sha',
                base_sha: 'main-sha',
                base_branch: 'main',
                version_number: null,
                source: 'submit',
              },
              last_reconciled_version: {
                head_sha: 'parent-new-sha',
                base_sha: 'main-sha',
                base_branch: 'main',
                source: 'submit',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              parent_revision: 'parent-new-sha',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'child-local-sha',
                base_sha: 'parent-old-sha',
                base_branch: 'feat/a',
                version_number: null,
                source: 'submit',
              },
              last_reconciled_version: {
                head_sha: 'child-local-sha',
                base_sha: 'parent-new-sha',
                base_branch: 'feat/a',
                source: 'sync-rebase-onto-remote',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
          ],
        },
      ],
    });
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockGetRefSha.mockImplementation(async (ref: string) => {
      switch (ref) {
        case 'main':
        case 'origin/main':
          return 'main-sha';
        case 'feat/a':
        case 'origin/feat/a':
          return 'parent-new-sha';
        case 'feat/b':
          return 'child-local-sha';
        case 'origin/feat/b':
          return 'child-remote-sha';
        default:
          return `${ref}-sha`;
      }
    });
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'main-sha' && right === 'parent-new-sha') return true;
      if (left === 'feat/b' && right === 'origin/feat/b') return true;
      if (left === 'origin/feat/b' && right === 'feat/b') return false;
      if (left === 'feat/a' && right === 'origin/feat/a') return true;
      if (left === 'origin/feat/a' && right === 'feat/a') return true;
      if (left === 'parent-old-sha' && right === 'child-remote-sha')
        return true;
      if (left === 'parent-new-sha' && right === 'child-remote-sha')
        return false;
      return false;
    });
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
      if (branch === 'feat/b') {
        return { state: 'OPEN', baseRefName: 'feat/a' };
      }
      return { state: 'OPEN', baseRefName: 'main' };
    });

    const result = await sync('/repo', {
      interactive: false,
      force: true,
      restack: false,
    });

    expect(
      result.branches.find((branch) => branch.branch === 'feat/b')?.action,
    ).toBe('synced');
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featB = writtenState.stacks[0].branches.find(
      (branch) => branch.name === 'feat/b',
    );
    expect(featB?.last_submitted_version?.base_sha).toBe('parent-old-sha');
    expect(featB?.last_reconciled_version?.base_sha).toBe('parent-old-sha');
    expect(featB?.parent_revision).toBe('parent-old-sha');
  });

  it('clears parent_revision when forced sync cannot trust the prior parent base', async () => {
    mockReadState.mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
              last_submitted_version: null,
              last_synced_at: null,
              sync_source: null,
            },
            {
              name: 'feat/a',
              parent: 'local-parent',
              parent_revision: 'stale-parent-sha',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'child-local-sha',
                base_sha: 'local-parent-sha',
                base_branch: 'local-parent',
                version_number: null,
                source: 'submit',
              },
              last_reconciled_version: {
                head_sha: 'child-local-sha',
                base_sha: 'stale-parent-sha',
                base_branch: 'local-parent',
                source: 'sync-rebase-onto-remote',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
          ],
        },
      ],
    });
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockGetRefSha.mockImplementation(async (ref: string) => {
      switch (ref) {
        case 'feat/a':
          return 'child-local-sha';
        case 'origin/feat/a':
          return 'child-remote-sha';
        case 'remote-parent':
          return 'remote-parent-sha';
        default:
          return `${ref}-sha`;
      }
    });
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'feat/a' && right === 'origin/feat/a') return false;
      if (left === 'origin/feat/a' && right === 'feat/a') return false;
      if (left === 'remote-parent-sha' && right === 'child-remote-sha')
        return false;
      return false;
    });
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'remote-parent',
    });

    const result = await sync('/repo', {
      interactive: false,
      force: true,
      restack: false,
    });

    expect(result.branches[0]?.action).toBe('synced');
    const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
    const featA = writtenState.stacks[0].branches.find(
      (branch) => branch.name === 'feat/a',
    );
    expect(featA?.parent).toBe('remote-parent');
    expect(featA?.last_submitted_version?.base_sha).toBe('remote-parent-sha');
    expect(featA?.parent_revision).toBeNull();
  });

  it('reports parent-mismatch after forced sync adopts an older remote child tip', async () => {
    let currentState: DubState = {
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
              last_submitted_version: null,
              last_synced_at: null,
              sync_source: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              parent_revision: 'main-sha',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'parent-new-sha',
                base_sha: 'main-sha',
                base_branch: 'main',
                version_number: null,
                source: 'submit',
              },
              last_reconciled_version: {
                head_sha: 'parent-new-sha',
                base_sha: 'main-sha',
                base_branch: 'main',
                source: 'submit',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              parent_revision: 'parent-new-sha',
              pr_number: null,
              pr_link: null,
              last_submitted_version: {
                head_sha: 'child-local-sha',
                base_sha: 'parent-old-sha',
                base_branch: 'feat/a',
                version_number: null,
                source: 'submit',
              },
              last_reconciled_version: {
                head_sha: 'child-local-sha',
                base_sha: 'parent-new-sha',
                base_branch: 'feat/a',
                source: 'sync-rebase-onto-remote',
              },
              last_synced_at: null,
              sync_source: 'submit',
            },
          ],
        },
      ],
    };
    const refShas: Record<string, string> = {
      main: 'main-sha',
      'origin/main': 'main-sha',
      'feat/a': 'parent-new-sha',
      'origin/feat/a': 'parent-new-sha',
      'feat/b': 'child-local-sha',
      'origin/feat/b': 'child-remote-sha',
    };
    mockReadState.mockImplementation(async () => structuredClone(currentState));
    mockWriteState.mockImplementation(async (nextState: DubState) => {
      currentState = structuredClone(nextState);
    });
    mockHardResetBranchToRef.mockImplementation(async (branch: string) => {
      refShas[branch] = refShas[`origin/${branch}`];
    });
    mockGetRefSha.mockImplementation(async (ref: string) => {
      return refShas[ref] ?? `${ref}-sha`;
    });
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'feat/b' && right === 'origin/feat/b') return true;
      if (left === 'origin/feat/b' && right === 'feat/b') return false;
      if (left === 'feat/a' && right === 'origin/feat/a') return true;
      if (left === 'origin/feat/a' && right === 'feat/a') return true;
      if (left === 'parent-old-sha' && right === 'child-remote-sha')
        return true;
      if (left === 'parent-new-sha' && right === 'child-remote-sha')
        return false;
      return false;
    });
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
      if (branch === 'feat/b') {
        return { state: 'OPEN', baseRefName: 'feat/a' };
      }
      return { state: 'OPEN', baseRefName: 'main' };
    });

    await sync('/repo', {
      interactive: false,
      force: true,
      restack: false,
    });

    const result = await doctor('/repo');
    const issue = result.issues.find(
      (entry) =>
        entry.code === 'parent-mismatch' &&
        entry.summary.includes("Branch 'feat/b'"),
    );

    expect(issue?.summary).toContain(
      "Branch 'feat/b' is no longer based on 'feat/a'",
    );
    expect(issue?.fixes[0]).toBe('dub restack');
    expect(result.healthy).toBe(false);
  });

  it('keeps local-ahead branches when PR base mismatches the tracked parent', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'local-parent' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-sha')
      .mockResolvedValueOnce('remote-sha');
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'feat/a' && right === 'origin/feat/a') return false;
      if (left === 'origin/feat/a' && right === 'feat/a') return true;
      return false;
    });
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'remote-parent',
    });

    const result = await sync('/repo', {
      interactive: false,
      force: true,
      restack: false,
    });

    expect(result.branches[0].status).toBe('local-ahead');
    expect(result.branches[0].action).toBe('kept-local');
    expect(mockHardResetBranchToRef).not.toHaveBeenCalled();
  });

  it('handles parent-mismatch status in non-interactive mode by skipping', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'local-parent' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-sha')
      .mockResolvedValueOnce('remote-sha');
    mockIsAncestor.mockResolvedValue(false);
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'remote-parent',
    });

    const result = await sync('/repo', {
      interactive: false,
      force: false,
      restack: false,
    });

    expect(result.branches[0].status).toBe('needs-remote-sync');
    expect(result.branches[0].action).toBe('skipped');
  });

  it('does not retarget PR bases when parent authority is unresolved', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'local-parent' },
      ]),
    );
    mockGetRefSha
      .mockResolvedValueOnce('local-sha')
      .mockResolvedValueOnce('remote-sha');
    mockIsAncestor.mockResolvedValue(false);
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'remote-parent',
    });

    await sync('/repo', {
      interactive: false,
      force: false,
      restack: false,
    });

    expect(mockRetargetPrBase).not.toHaveBeenCalled();
  });

  it('throws actionable recovery guidance when restack phase conflicts', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockRestack.mockResolvedValue({
      status: 'conflict',
      rebased: [],
      conflictBranch: 'feat/a',
    });
    mockDetectActiveOperation.mockResolvedValue('restack');

    let captured: DubError | null = null;
    try {
      await sync('/repo', { interactive: false, restack: true });
    } catch (error) {
      captured = error as DubError;
    }
    expect(captured).toBeInstanceOf(DubError);
    expect(captured?.message).toContain(
      "Sync paused: conflict while restacking 'feat/a'",
    );
    expect(captured?.recovery).toEqual(
      expect.arrayContaining([
        expect.stringContaining('dub continue --ai'),
        expect.stringContaining('dub continue'),
        expect.stringContaining('dub abort'),
      ]),
    );
  });

  it('cancel-and-rollback during restack conflict restores to pre-restack branch even when prior cleanup ran (DUB-15)', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/c');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
        { name: 'feat/c', parent: 'feat/b' },
      ]),
    );
    // Up-to-date branches so the reconcile prompt is never invoked.
    mockGetRefSha.mockResolvedValue('same-sha');
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') {
        return { state: 'MERGED', baseRefName: 'main' };
      }
      return { state: 'OPEN', baseRefName: 'main' };
    });
    mockRestack.mockResolvedValue({
      status: 'conflict',
      rebased: [],
      conflictBranch: 'feat/c',
    });
    mockRestackConflictPrompt.mockResolvedValue('cancel');
    mockRollbackRestack.mockResolvedValue({
      branchesRestored: 3,
      previousBranch: 'feat/c',
    });
    mockDetectActiveOperation.mockResolvedValue('none');

    const result = await sync('/repo', { interactive: true, restack: true });

    expect(mockRollbackRestack).toHaveBeenCalledWith('/repo');
    expect(result.restacked).toBe(false);
    // The final checkout must be the rollback target, NOT the
    // resolvePreferredBranch result triggered by the merged-branch cleanup.
    expect(mockCheckoutBranch).toHaveBeenLastCalledWith('feat/c', '/repo');
  });

  it('throws exit DubError when user picks "Exit and leave" (DUB-15)', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockRestack.mockResolvedValue({
      status: 'conflict',
      rebased: [],
      conflictBranch: 'feat/a',
    });
    mockRestackConflictPrompt.mockResolvedValue('exit');
    mockDetectActiveOperation.mockResolvedValue('restack');

    let captured: DubError | null = null;
    try {
      await sync('/repo', { interactive: true, restack: true });
    } catch (error) {
      captured = error as DubError;
    }
    expect(captured).toBeInstanceOf(DubError);
    expect(captured?.message).toContain('Sync exited mid-conflict');
    expect(captured?.recovery).toEqual(
      expect.arrayContaining([
        expect.stringContaining('dub continue'),
        expect.stringContaining('dub abort'),
      ]),
    );
  });

  describe('expanded status taxonomy (DUB-14)', () => {
    it('auto-rebases on non-conflicting-divergence', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
        ]),
      );
      mockGetRefSha
        .mockResolvedValueOnce('local-a')
        .mockResolvedValueOnce('remote-a')
        .mockResolvedValue('rebased-a');
      mockIsAncestor.mockResolvedValue(false);
      mockRebaseBranchOntoRef.mockResolvedValue(true);

      const result = await sync('/repo', {
        interactive: false,
        force: false,
        restack: false,
      });

      expect(mockRebaseBranchOntoRef).toHaveBeenCalledWith(
        'feat/a',
        'origin/feat/a',
        '/repo',
      );
      expect(result.branches[0].status).toBe('non-conflicting-divergence');
      expect(result.branches[0].action).toBe('synced');
      expect(result.branches[0].reconcileSource).toBe(
        'sync-rebase-onto-remote',
      );
      expect(result.reconcileSources['sync-rebase-onto-remote']).toBe(1);
    });

    it('detects remote-restacked when remote PR base differs and remote contains new parent history', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
        ]),
      );
      mockGetRefSha
        .mockResolvedValueOnce('local-a')
        .mockResolvedValueOnce('remote-a');
      mockIsAncestor.mockImplementation(async (left: string, right: string) => {
        // diverged from remote
        if (left === 'feat/a' && right === 'origin/feat/a') return false;
        if (left === 'origin/feat/a' && right === 'feat/a') return false;
        // origin/new-parent IS ancestor of origin/feat/a (remote moved onto it)
        if (left === 'origin/new-parent' && right === 'origin/feat/a')
          return true;
        return false;
      });
      mockGetBranchPrSyncInfo.mockResolvedValue({
        state: 'OPEN',
        baseRefName: 'new-parent',
      });

      const result = await sync('/repo', {
        interactive: false,
        force: false,
        restack: false,
      });

      expect(result.branches[0].status).toBe('remote-restacked');
      expect(result.branches[0].action).toBe('synced');
      expect(result.branches[0].reconcileSource).toBe('sync-remote-restacked');
      expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
        'feat/a',
        'origin/feat/a',
        '/repo',
      );
      const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
      expect(
        writtenState.stacks[0].branches.find((b) => b.name === 'feat/a')
          ?.parent,
      ).toBe('new-parent');
      expect(
        writtenState.last_sync?.reconcile_sources['sync-remote-restacked'],
      ).toBe(1);
    });

    it('emits parent-merged-orphan outcome when parent PR was merged and child reparented', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
          { name: 'feat/b', parent: 'feat/a' },
        ]),
      );
      mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => ({
        state: branch === 'feat/a' ? 'MERGED' : 'OPEN',
        baseRefName: branch === 'feat/a' ? 'main' : 'feat/a',
      }));
      mockGetAllPrSyncInfoBatch.mockResolvedValue({
        byBranch: new Map([
          ['feat/a', { state: 'MERGED', baseRefName: 'main' }],
          ['feat/b', { state: 'OPEN', baseRefName: 'feat/a' }],
        ]),
        truncated: false,
      });

      const result = await sync('/repo', {
        interactive: false,
        force: false,
        restack: false,
      });

      const orphan = result.branches.find((b) => b.branch === 'feat/b');
      expect(orphan?.status).toBe('parent-merged-orphan');
      expect(orphan?.action).toBe('synced');
      expect(orphan?.reconcileSource).toBe('sync-parent-merged-reparent');
      expect(result.reconcileSources['sync-parent-merged-reparent']).toBe(1);
    });

    it('records squash-merged-with-trailing-commits outcome when patch-id reports trailing commits', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
        ]),
      );
      mockGetBranchPrSyncInfo.mockResolvedValue({
        state: 'MERGED',
        baseRefName: 'main',
      });
      // not all branch commits are in trunk → trailing commits remain
      mockIsMergedByPatchId.mockResolvedValue(false);

      const result = await sync('/repo', {
        interactive: false,
        force: false,
        restack: false,
      });

      const outcome = result.branches.find((b) => b.branch === 'feat/a');
      expect(outcome?.status).toBe('squash-merged-with-trailing-commits');
      expect(outcome?.action).toBe('deleted');
      expect(outcome?.reconcileSource).toBe('sync-squash-merged-cleanup');
      expect(result.cleaned).toContain('feat/a');
      expect(result.reconcileSources['sync-squash-merged-cleanup']).toBe(1);
    });

    it('refinement: needs-remote-sync auto-FFs and adopts remote parent when local is strict subset', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'local-parent' },
        ]),
      );
      mockGetRefSha
        .mockResolvedValueOnce('local-a')
        .mockResolvedValueOnce('remote-a');
      mockIsAncestor.mockImplementation(async (left: string, right: string) => {
        if (left === 'feat/a' && right === 'origin/feat/a') return true;
        return false;
      });
      mockGetBranchPrSyncInfo.mockResolvedValue({
        state: 'OPEN',
        baseRefName: 'remote-parent',
      });

      const result = await sync('/repo', {
        interactive: false,
        force: false,
        restack: false,
      });

      expect(result.branches[0].status).toBe('needs-remote-sync-safe');
      expect(result.branches[0].action).toBe('synced');
      expect(result.branches[0].reconcileSource).toBe(
        'sync-adopt-remote-parent',
      );
      expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
        'feat/a',
        'origin/feat/a',
        '/repo',
      );
      const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
      expect(
        writtenState.stacks[0].branches.find((b) => b.name === 'feat/a')
          ?.parent,
      ).toBe('remote-parent');
    });

    it('refinement: unsubmitted in non-interactive adopts silently when SHAs already equal', async () => {
      // No baseline + SHAs equal → updated-outside-dubstack-but-up-to-date
      // which adopts silently (no prompt). Verified by 'imported' source +
      // synced state with no skip.
      mockReadState.mockResolvedValue({
        stacks: [
          {
            id: 'stack-1',
            branches: [
              {
                name: 'main',
                parent: null,
                type: 'root',
                pr_number: null,
                pr_link: null,
                last_submitted_version: null,
                last_synced_at: null,
                sync_source: null,
              },
              {
                name: 'feat/a',
                parent: 'main',
                pr_number: null,
                pr_link: null,
                last_submitted_version: null,
                last_synced_at: null,
                sync_source: null,
              },
            ],
          },
        ],
      });
      mockGetRefSha.mockResolvedValue('same-sha');

      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      expect(result.branches[0].status).toBe(
        'updated-outside-dubstack-but-up-to-date',
      );
      expect(result.branches[0].action).toBe('none');
      expect(result.branches[0].reconcileSource).toBe('sync-no-change');
    });

    it('persists last_sync histogram in state after sync', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');

      await sync('/repo', { interactive: false, restack: false });

      const writtenState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
      expect(writtenState.last_sync?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(writtenState.last_sync?.reconcile_sources['sync-no-change']).toBe(
        1,
      );
    });
  });

  describe('batched PR sync info', () => {
    it('uses the batched map and skips per-branch gh calls when not truncated', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
          { name: 'feat/b', parent: 'feat/a' },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');
      mockGetAllPrSyncInfoBatch.mockResolvedValue({
        byBranch: new Map([
          ['feat/a', { state: 'OPEN', baseRefName: 'main' }],
          ['feat/b', { state: 'OPEN', baseRefName: 'feat/a' }],
        ]),
        truncated: false,
      });

      await sync('/repo', { interactive: false, restack: false });

      expect(mockGetAllPrSyncInfoBatch).toHaveBeenCalledTimes(1);
      expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
      expect(mockGetBranchPrLifecycleState).not.toHaveBeenCalled();
    });

    it('cleans a merged branch using the batched map without per-branch calls', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
        ]),
      );
      mockGetAllPrSyncInfoBatch.mockResolvedValue({
        byBranch: new Map([
          ['feat/a', { state: 'MERGED', baseRefName: 'main' }],
        ]),
        truncated: false,
      });

      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      expect(mockDeleteBranch).toHaveBeenCalledWith('feat/a', '/repo');
      expect(result.cleaned).toContain('feat/a');
      expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
    });

    it('skips the batch gh call when the stack has no non-root branches', async () => {
      mockGetCurrentBranch.mockResolvedValue('main');
      mockReadState.mockResolvedValue(
        makeState([{ name: 'main', parent: null, type: 'root' }]),
      );

      await sync('/repo', { interactive: false, restack: false });

      expect(mockGetAllPrSyncInfoBatch).not.toHaveBeenCalled();
      expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
    });

    it('falls back to per-branch lookup when the batch reports truncation', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');
      // Branch absent from the truncated batch must trigger a per-branch call.
      mockGetAllPrSyncInfoBatch.mockResolvedValue({
        byBranch: new Map(),
        truncated: true,
      });
      mockGetBranchPrSyncInfo.mockResolvedValue({
        state: 'OPEN',
        baseRefName: 'main',
      });

      await sync('/repo', { interactive: false, restack: false });

      expect(mockGetBranchPrSyncInfo).toHaveBeenCalledWith('feat/a', '/repo');
    });
  });

  describe('fresh / last_synced_at caching', () => {
    function makeStateWithSync(
      branches: {
        name: string;
        parent: string | null;
        type?: 'root';
        last_synced_at?: string | null;
      }[],
    ): DubState {
      return {
        stacks: [
          {
            id: 'stack-1',
            branches: branches.map((b) => ({
              name: b.name,
              parent: b.parent,
              type: b.type,
              pr_number: null,
              pr_link: null,
              last_submitted_version:
                b.type === 'root'
                  ? null
                  : {
                      head_sha: `${b.name}-sha`,
                      base_sha: `${b.parent ?? 'main'}-sha`,
                      base_branch: b.parent ?? 'main',
                      version_number: null,
                      source: 'submit',
                    },
              last_synced_at: b.last_synced_at ?? null,
              sync_source: b.type === 'root' ? null : 'submit',
            })),
          },
        ],
      };
    }

    it('partitions recently-synced branches out of the fetch list', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: recent },
          { name: 'feat/b', parent: 'feat/a', last_synced_at: recent },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');

      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      expect(mockFetchBranches).toHaveBeenCalledTimes(1);
      expect(mockFetchBranches).toHaveBeenCalledWith(
        ['main'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
      const featA = result.branches.find((b) => b.branch === 'feat/a');
      const featB = result.branches.find((b) => b.branch === 'feat/b');
      expect(featA?.status).toBe('fresh');
      expect(featA?.action).toBe('cached');
      expect(featB?.status).toBe('fresh');
    });

    it('still fetches branches synced more than 5 minutes ago', async () => {
      const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: stale },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');

      await sync('/repo', { interactive: false, restack: false });

      expect(mockFetchBranches).toHaveBeenCalledWith(
        ['main', 'feat/a'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
    });

    it('--fresh forces a full fetch of every tracked branch', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: recent },
          { name: 'feat/b', parent: 'feat/a', last_synced_at: recent },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');

      const result = await sync('/repo', {
        interactive: false,
        restack: false,
        fresh: true,
      });

      expect(mockFetchBranches).toHaveBeenCalledWith(
        ['main', 'feat/a', 'feat/b'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
      expect(result.branches.find((b) => b.status === 'fresh')).toBeUndefined();
    });

    it('still runs the batched gh pr list when every branch is cached', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: recent },
        ]),
      );
      mockGetAllPrSyncInfoBatch.mockResolvedValue({
        byBranch: new Map([['feat/a', { state: 'OPEN', baseRefName: 'main' }]]),
        truncated: false,
      });
      mockGetRefSha.mockResolvedValue('same-sha');

      await sync('/repo', { interactive: false, restack: false });

      expect(mockGetAllPrSyncInfoBatch).toHaveBeenCalledTimes(1);
      expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
    });

    it('still cleans a merged branch even when its last_synced_at is fresh', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: recent },
        ]),
      );
      mockGetAllPrSyncInfoBatch.mockResolvedValue({
        byBranch: new Map([
          ['feat/a', { state: 'MERGED', baseRefName: 'main' }],
        ]),
        truncated: false,
      });

      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      expect(mockDeleteBranch).toHaveBeenCalledWith('feat/a', '/repo');
      expect(result.cleaned).toContain('feat/a');
      expect(result.branches).toHaveLength(0);
    });

    it('skips skipping when last_synced_at is unparseable (defensive)', async () => {
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: 'not-a-date' },
        ]),
      );
      mockGetRefSha.mockResolvedValue('same-sha');

      await sync('/repo', { interactive: false, restack: false });

      expect(mockFetchBranches).toHaveBeenCalledWith(
        ['main', 'feat/a'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
    });

    it('falls through to missing-remote when a fresh-cached branch was pruned upstream', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      mockReadState.mockResolvedValue(
        makeStateWithSync([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main', last_synced_at: recent },
        ]),
      );
      // Simulate `pruneRemote` having dropped origin/feat/a since the last sync.
      mockRemoteBranchExists.mockImplementation(
        async (branch: string) => branch !== 'feat/a',
      );
      mockGetRefSha.mockResolvedValue('same-sha');

      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      const featA = result.branches.find((b) => b.branch === 'feat/a');
      expect(featA?.status).toBe('missing-remote');
      expect(featA?.action).toBe('skipped');
    });

    it('stamps last_synced_at for local-ahead branches so re-sync skips fetch', async () => {
      let currentState: DubState = makeStateWithSync([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]);
      mockReadState.mockImplementation(async () =>
        structuredClone(currentState),
      );
      mockWriteState.mockImplementation(async (next: DubState) => {
        currentState = structuredClone(next);
      });
      mockGetRefSha.mockImplementation(async (ref: string) =>
        ref === 'feat/a' ? 'local-sha' : 'remote-sha',
      );
      mockIsAncestor.mockImplementation(async (left: string, right: string) => {
        if (left === 'origin/feat/a' && right === 'feat/a') return true;
        return false;
      });

      const first = await sync('/repo', {
        interactive: false,
        restack: false,
      });
      expect(first.branches[0].status).toBe('local-ahead');
      const featAFirst = currentState.stacks[0].branches.find(
        (b) => b.name === 'feat/a',
      );
      expect(featAFirst?.last_synced_at).toBeTruthy();

      mockFetchBranches.mockClear();
      await sync('/repo', { interactive: false, restack: false });
      expect(mockFetchBranches).toHaveBeenCalledWith(
        ['main'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
    });

    it('second consecutive sync only fetches trunk (idempotency)', async () => {
      // Stateful mock: first sync writes last_synced_at, second sync reads it back
      let currentState: DubState = makeStateWithSync([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]);
      mockReadState.mockImplementation(async () =>
        structuredClone(currentState),
      );
      mockWriteState.mockImplementation(async (next: DubState) => {
        currentState = structuredClone(next);
      });
      mockGetRefSha.mockResolvedValue('same-sha');

      // First sync — everything must fetch.
      await sync('/repo', { interactive: false, restack: false });

      expect(mockFetchBranches).toHaveBeenLastCalledWith(
        ['main', 'feat/a', 'feat/b'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
      const writtenAfterFirst = currentState.stacks[0].branches.find(
        (b) => b.name === 'feat/a',
      );
      expect(writtenAfterFirst?.last_synced_at).toBeTruthy();

      mockFetchBranches.mockClear();

      // Second sync — recently-synced branches now skip the fetch.
      const result = await sync('/repo', {
        interactive: false,
        restack: false,
      });

      expect(mockFetchBranches).toHaveBeenCalledTimes(1);
      expect(mockFetchBranches).toHaveBeenCalledWith(
        ['main'],
        '/repo',
        'origin',
        expect.objectContaining({ onBranchStart: expect.any(Function) }),
      );
      const cached = result.branches.filter((b) => b.status === 'fresh');
      expect(cached.map((b) => b.branch).sort()).toEqual(['feat/a', 'feat/b']);
    });
  });

  describe('per-branch error isolation', () => {
    it('continues processing other branches when one branch errors', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
          { name: 'feat/b', parent: 'main' },
          { name: 'feat/c', parent: 'main' },
        ]),
      );
      // Drive every non-root branch into the 'needs-remote-sync-safe' path so
      // each one calls hardResetBranchToRef where we can inject a per-branch
      // failure.
      mockGetRefSha.mockImplementation(async (ref: string) =>
        ref.startsWith('origin/') ? `${ref}-remote-sha` : `${ref}-local-sha`,
      );
      mockIsAncestor.mockImplementation(
        async (a: string, _b: string) => !a.startsWith('origin/'),
      );
      mockHardResetBranchToRef.mockImplementation(async (branch: string) => {
        if (branch === 'feat/b') {
          throw new DubError(
            "Failed to hard reset 'feat/b' to 'origin/feat/b'.\nfatal: simulated branch failure",
            ['Re-run after the simulated outage clears.'],
          );
        }
      });
      mockSubmit.mockResolvedValue({
        pushed: [],
        created: [],
        updated: [],
        scope: { kind: 'downstack' },
        dryRun: false,
      });

      let captured: DubError | null = null;
      try {
        await sync('/repo', { interactive: false, all: true, restack: false });
      } catch (err) {
        captured = err as DubError;
      }

      expect(captured).toBeInstanceOf(DubError);
      const finalState = mockWriteState.mock.calls.at(-1)?.[0] as DubState;
      expect(finalState).toBeDefined();

      const errored = mockHardResetBranchToRef.mock.calls.map((c) => c[0]);
      // Sync should have attempted all three non-root branches even after
      // 'feat/b' failed.
      expect(errored).toEqual(
        expect.arrayContaining(['feat/a', 'feat/b', 'feat/c']),
      );
    });

    it('captures per-branch errors into outcomes with action="error"', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
          { name: 'feat/b', parent: 'main' },
        ]),
      );
      mockGetRefSha.mockImplementation(async (ref: string) =>
        ref.startsWith('origin/') ? `${ref}-remote-sha` : `${ref}-local-sha`,
      );
      mockIsAncestor.mockImplementation(
        async (a: string, _b: string) => !a.startsWith('origin/'),
      );
      mockHardResetBranchToRef.mockImplementation(async (branch: string) => {
        if (branch === 'feat/a') {
          throw new DubError("Reset failed for 'feat/a'.", [
            "Run 'dub doctor' to inspect the branch.",
          ]);
        }
      });

      let captured: DubError | null = null;
      try {
        await sync('/repo', { interactive: false, all: true, restack: false });
      } catch (err) {
        captured = err as DubError;
      }

      expect(captured).toBeInstanceOf(DubError);
      expect(captured?.message).toContain('feat/a');
      expect(captured?.message).toContain("Reset failed for 'feat/a'.");
      expect(captured?.recovery.length).toBeGreaterThan(0);
    });

    it('exits non-zero (throws aggregate DubError) when any branch errored', async () => {
      mockReadState.mockResolvedValue(
        makeState([
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
          { name: 'feat/b', parent: 'main' },
        ]),
      );
      mockGetRefSha.mockImplementation(async (ref: string) =>
        ref.startsWith('origin/') ? `${ref}-remote-sha` : `${ref}-local-sha`,
      );
      mockIsAncestor.mockImplementation(
        async (a: string, _b: string) => !a.startsWith('origin/'),
      );
      mockHardResetBranchToRef.mockImplementation(async (branch: string) => {
        if (branch === 'feat/a') {
          throw new DubError("Reset failed for 'feat/a'.");
        }
      });

      await expect(
        sync('/repo', { interactive: false, all: true, restack: false }),
      ).rejects.toThrow(/Sync completed with errors on 1 branch\(es\)/);
    });
  });

  describe('detached_root handling', () => {
    it('does NOT fast-forward a root marked detached_root (would clobber feature branch commits)', async () => {
      // After `dub unlink feat/x`, feat/x lives in its own stack as
      // type: 'root', detached_root: true. The trunk FF loop must skip it —
      // otherwise sync would `git branch -f feat/x origin/feat/x` under
      // --force and silently overwrite local commits.
      mockReadState.mockResolvedValue({
        stacks: [
          {
            id: 'stack-1',
            branches: [
              {
                name: 'main',
                type: 'root',
                parent: null,
                pr_number: null,
                pr_link: null,
                last_submitted_version: null,
                last_synced_at: null,
                sync_source: null,
              },
              {
                name: 'feat/a',
                parent: 'main',
                pr_number: null,
                pr_link: null,
                last_submitted_version: {
                  head_sha: 'feat/a-sha',
                  base_sha: 'main-sha',
                  base_branch: 'main',
                  version_number: null,
                  source: 'submit',
                },
                last_synced_at: null,
                sync_source: 'submit',
              },
            ],
          },
          {
            id: 'stack-2',
            branches: [
              {
                name: 'feat/unlinked',
                type: 'root',
                detached_root: true,
                parent: null,
                pr_number: 99,
                pr_link: 'https://x/99',
                last_submitted_version: null,
                last_synced_at: null,
                sync_source: null,
              },
            ],
          },
        ],
      });
      // Force the FF check to "needs reset" so we'd see hardReset called if
      // sync mistakenly included the detached root in the trunk loop.
      mockFastForwardBranchToRef.mockResolvedValue(false);

      const result = await sync('/repo', {
        interactive: false,
        all: true,
        force: true,
        restack: false,
      });

      // FF and hardReset must NEVER be called for the detached root.
      expect(mockFastForwardBranchToRef).not.toHaveBeenCalledWith(
        'feat/unlinked',
        'origin/feat/unlinked',
        '/repo',
      );
      expect(mockHardResetBranchToRef).not.toHaveBeenCalledWith(
        'feat/unlinked',
        'origin/feat/unlinked',
        '/repo',
      );
      // Real trunk (main) WAS treated as a trunk.
      expect(result.trunksSynced).not.toContain('feat/unlinked');
    });
  });
});
