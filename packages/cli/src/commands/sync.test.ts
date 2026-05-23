import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DubError } from '../lib/errors';

vi.mock('../lib/git.js', () => ({
  branchExists: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  deleteBranch: vi.fn(),
  fastForwardBranchToRef: vi.fn(),
  fetchBranches: vi.fn(),
  getCurrentBranch: vi.fn(),
  getRefSha: vi.fn(),
  hardResetBranchToRef: vi.fn(),
  isAncestor: vi.fn(),
  remoteBranchExists: vi.fn(),
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
  deleteBranch,
  fastForwardBranchToRef,
  fetchBranches,
  getCurrentBranch,
  getRefSha,
  hardResetBranchToRef,
  isAncestor,
  remoteBranchExists,
} from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getAllPrSyncInfoBatch,
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import { detectActiveOperation } from '../lib/operation-state';
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
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetRefSha = getRefSha as ReturnType<typeof vi.fn>;
const mockHardResetBranchToRef = hardResetBranchToRef as ReturnType<
  typeof vi.fn
>;
const mockIsAncestor = isAncestor as ReturnType<typeof vi.fn>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
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

function makeState(
  branches: { name: string; parent: string | null; type?: 'root' }[],
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
  mockFastForwardBranchToRef.mockResolvedValue(true);
  mockBranchExists.mockResolvedValue(true);
  mockRemoteBranchExists.mockResolvedValue(true);
  mockGetRefSha.mockImplementation(async (ref: string) => `${ref}-sha`);
  mockIsAncestor.mockResolvedValue(false);
  mockHardResetBranchToRef.mockResolvedValue(undefined);
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
    path: 'current',
    dryRun: false,
    fallbackApplied: false,
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
    expect(mockFetchBranches).toHaveBeenCalledWith(['main', 'feat/a'], '/repo');
    expect(result.fetched).toEqual(['main', 'feat/a']);
    expect(result.branches[0].status).toBe('up-to-date');
    expect(mockRestack).not.toHaveBeenCalled();
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

  it('skips diverged branch in non-interactive mode without force', async () => {
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

    const result = await sync('/repo', { interactive: false, restack: false });

    expect(result.branches[0].status).toBe('reconcile-needed');
    expect(result.branches[0].action).toBe('skipped');
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
    expect(featA?.last_reconciled_version?.source).toBe('sync-noop');
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
      if (options?.path !== 'stack') {
        throw new Error(`expected full-stack refresh, got ${options?.path}`);
      }
      return {
        pushed: ['feat/b', 'feat/c'],
        created: [],
        updated: ['feat/b', 'feat/c'],
        path: 'stack',
        dryRun: false,
        fallbackApplied: false,
      };
    });

    await sync('/repo', { interactive: false, restack: false });

    expect(mockRetargetPrBase).toHaveBeenCalledWith('feat/b', 'main', '/repo');
    expect(mockSubmit).toHaveBeenCalledWith('/repo', false, {
      path: 'stack',
      fix: true,
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
      source: 'sync-noop',
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
                source: 'sync-restack',
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
                source: 'sync-restack',
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
                source: 'sync-restack',
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
});
