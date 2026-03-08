import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getBranchPrLifecycleState: vi.fn(),
  getBranchPrSyncInfo: vi.fn(),
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
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
} from '../lib/github';
import { detectActiveOperation } from '../lib/operation-state';
import type { DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { restack } from './restack';
import { sync } from './sync';

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
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;

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
  mockDetectActiveOperation.mockResolvedValue('none');
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockWriteState.mockResolvedValue(undefined);
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

  it('does not restack unless --restack is explicitly requested', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await sync('/repo', { interactive: false });
    expect(result.restacked).toBe(false);
    expect(mockRestack).not.toHaveBeenCalled();
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
  });

  it('cleans merged branch automatically without force', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetBranchPrLifecycleState.mockResolvedValue('MERGED');

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
    mockGetBranchPrLifecycleState.mockImplementation(async (branch: string) =>
      branch === 'feat/a' ? 'MERGED' : 'OPEN',
    );
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
    mockGetBranchPrLifecycleState.mockImplementation(async (branch: string) =>
      branch === 'feat/a' ? 'MERGED' : 'OPEN',
    );

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

    await expect(
      sync('/repo', { interactive: false, restack: true }),
    ).rejects.toThrow('dub continue');
    await expect(
      sync('/repo', { interactive: false, restack: true }),
    ).rejects.toThrow('dub abort');
  });
});
