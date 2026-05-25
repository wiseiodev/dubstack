import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/git.js', () => ({
  checkoutBranch: vi.fn(),
  fastForwardBranchToRef: vi.fn(),
  fetchBranches: vi.fn(),
  formatWorktreeCheckoutSkipMessage: vi.fn(
    (branch: string, worktreePath: string, command = 'dub sync') =>
      `ℹ Skipped '${branch}' — checked out in ${worktreePath}.\n   Run \`${command}\` from that worktree to update it.`,
  ),
  getCurrentBranch: vi.fn(),
  listWorktreeCheckouts: vi.fn(),
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
}));

vi.mock('../lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state.js')>();
  return {
    ...actual,
    readState: vi.fn(),
    writeState: vi.fn(),
  };
});

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getBranchPrLifecycleState: vi.fn(),
  getBranchPrSyncInfo: vi.fn(),
  retargetPrBase: vi.fn(),
}));

vi.mock('./restack.js', () => ({
  restack: vi.fn(),
}));

vi.mock('./submit.js', () => ({
  submit: vi.fn(),
}));

import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import {
  checkoutBranch,
  fastForwardBranchToRef,
  fetchBranches,
  getCurrentBranch,
  listWorktreeCheckouts,
  remoteBranchExists,
} from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import type { DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { postMerge } from './post-merge';
import { restack } from './restack';
import { submit } from './submit';

const mockCheckoutBranch = checkoutBranch as ReturnType<typeof vi.fn>;
const mockFastForwardBranchToRef = fastForwardBranchToRef as ReturnType<
  typeof vi.fn
>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockListWorktreeCheckouts = listWorktreeCheckouts as ReturnType<
  typeof vi.fn
>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetBranchPrLifecycleState = getBranchPrLifecycleState as ReturnType<
  typeof vi.fn
>;
const mockGetBranchPrSyncInfo = getBranchPrSyncInfo as ReturnType<typeof vi.fn>;
const mockRetargetPrBase = retargetPrBase as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockRestack = restack as ReturnType<typeof vi.fn>;
const mockSubmit = submit as ReturnType<typeof vi.fn>;
const mockStartCleanupJournal = startCleanupJournal as ReturnType<typeof vi.fn>;
const mockAppendCleanupOperation = appendCleanupOperation as ReturnType<
  typeof vi.fn
>;
const mockClearCleanupJournal = clearCleanupJournal as ReturnType<typeof vi.fn>;

function makeState(): DubState {
  return {
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
          },
          {
            name: 'feat/a',
            parent: 'main',
            pr_number: 1,
            pr_link: 'https://x/1',
          },
          {
            name: 'feat/b',
            parent: 'feat/a',
            pr_number: 2,
            pr_link: 'https://x/2',
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentBranch.mockResolvedValue('feat/b');
  mockFetchBranches.mockResolvedValue(undefined);
  mockFastForwardBranchToRef.mockResolvedValue(true);
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockRemoteBranchExists.mockResolvedValue(true);
  mockListWorktreeCheckouts.mockResolvedValue(new Map());
  mockReadState.mockResolvedValue(makeState());
  mockWriteState.mockResolvedValue(undefined);
  mockGetBranchPrLifecycleState.mockImplementation(async (branch: string) => {
    if (branch === 'feat/a') return 'MERGED';
    if (branch === 'feat/b') return 'OPEN';
    return 'NONE';
  });
  mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
    if (branch === 'feat/b') {
      return { state: 'OPEN', baseRefName: 'feat/a' };
    }
    return { state: 'NONE', baseRefName: null };
  });
  mockRetargetPrBase.mockResolvedValue(undefined);
  mockRestack.mockResolvedValue({ status: 'up-to-date', rebased: [] });
  mockSubmit.mockResolvedValue({
    pushed: ['feat/b'],
    created: [],
    updated: ['feat/b'],
    webOpened: [],
    scope: { kind: 'downstack' },
    dryRun: false,
  });
});

describe('postMerge', () => {
  it('removes merged bottom branches, reparents children, and retargets PR base', async () => {
    const result = await postMerge('/repo', {
      restack: false,
      submit: false,
    });

    expect(result.cleaned).toEqual(['feat/a']);
    expect(result.retargeted).toEqual(['feat/b']);
    expect(mockRetargetPrBase).toHaveBeenCalledWith('feat/b', 'main', '/repo');
    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const featB = saved.stacks[0].branches.find((b) => b.name === 'feat/b');
    expect(featB?.parent).toBe('main');
  });

  it('skips merged branches checked out in another worktree', async () => {
    mockListWorktreeCheckouts.mockResolvedValue(
      new Map([['feat/a', '/repo-worktree']]),
    );

    const result = await postMerge('/repo', {
      restack: false,
      submit: false,
    });

    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toEqual(['feat/a']);
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const featB = saved.stacks[0].branches.find((b) => b.name === 'feat/b');
    expect(featB?.parent).toBe('feat/a');
  });

  it('skips merged frozen branches without reparenting or cleaning them', async () => {
    const frozenState = makeState();
    const featA = frozenState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    if (featA) featA.frozen = true;
    mockReadState.mockResolvedValue(frozenState);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = await postMerge('/repo', {
        restack: false,
        submit: false,
      });

      expect(result.cleaned).toEqual([]);
      expect(result.skipped).toEqual(['feat/a']);
      expect(mockRetargetPrBase).not.toHaveBeenCalled();
      const saved = mockWriteState.mock.calls[0][0] as DubState;
      expect(
        saved.stacks[0].branches.find((b) => b.name === 'feat/a'),
      ).toBeTruthy();
      expect(
        saved.stacks[0].branches.find((b) => b.name === 'feat/b')?.parent,
      ).toBe('feat/a');
      expect(logSpy).toHaveBeenCalledWith(
        "🔒 Skipped 'feat/a' (frozen). Run `dub unfreeze feat/a` to allow post-merge cleanup.",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('preserves parent_revision on reparented children', async () => {
    const stateWithRevision: DubState = {
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
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: 1,
              pr_link: 'https://x/1',
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              parent_revision: 'a-tip-sha-original',
              pr_number: 2,
              pr_link: 'https://x/2',
            },
          ],
        },
      ],
    };
    mockReadState.mockResolvedValue(stateWithRevision);

    const result = await postMerge('/repo', {
      restack: false,
      submit: false,
    });

    expect(result.cleaned).toEqual(['feat/a']);
    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const featB = saved.stacks[0].branches.find((b) => b.name === 'feat/b');
    expect(featB?.parent).toBe('main');
    expect(featB?.parent_revision).toBe('a-tip-sha-original');
  });

  it('supports dry-run without mutating state', async () => {
    const result = await postMerge('/repo', {
      dryRun: true,
    });

    expect(result.cleaned).toEqual(['feat/a']);
    expect(mockWriteState).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
    expect(mockRestack).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('runs restack and submit maintenance by default', async () => {
    await postMerge('/repo');

    expect(mockFetchBranches).toHaveBeenCalledWith(['main'], '/repo');
    expect(mockFastForwardBranchToRef).toHaveBeenCalledWith(
      'main',
      'origin/main',
      '/repo',
    );
    expect(mockRestack).toHaveBeenCalled();
    expect(mockSubmit).toHaveBeenCalledWith('/repo', false, {
      stack: true,
    });
    expect(mockCheckoutBranch).toHaveBeenCalledWith('main', '/repo');
  });

  it('refreshes from the surviving child branch when the original branch is trunk', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
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
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: 1,
              pr_link: 'https://x/1',
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              pr_number: 2,
              pr_link: 'https://x/2',
            },
            {
              name: 'feat/c',
              parent: 'feat/b',
              pr_number: 3,
              pr_link: 'https://x/3',
            },
          ],
        },
      ],
    });
    mockGetBranchPrLifecycleState.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') return 'MERGED';
      if (branch === 'feat/b' || branch === 'feat/c') return 'OPEN';
      return 'NONE';
    });
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
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
        webOpened: [],
        scope: { kind: 'stack' },
        dryRun: false,
      };
    });

    const result = await postMerge('/repo');

    expect(result.submittedBranches).toEqual(['feat/b', 'feat/c']);
    expect(mockCheckoutBranch).toHaveBeenCalledWith('feat/b', '/repo');
  });

  it('fails before restack when the local root cannot be fast-forwarded to remote', async () => {
    mockFastForwardBranchToRef.mockResolvedValue(false);

    await expect(postMerge('/repo')).rejects.toThrow(
      "Post-merge could not fast-forward trunk 'main' to 'origin/main'",
    );
    expect(mockRestack).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('submits each stack when --all is enabled', async () => {
    const allStacksState: DubState = {
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
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: 1,
              pr_link: 'https://x/1',
            },
          ],
        },
        {
          id: 'stack-2',
          branches: [
            {
              name: 'develop',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/c',
              parent: 'develop',
              pr_number: 3,
              pr_link: 'https://x/3',
            },
          ],
        },
      ],
    };
    mockReadState.mockResolvedValue(allStacksState);
    mockGetBranchPrLifecycleState.mockResolvedValue('OPEN');
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'main',
    });
    mockSubmit.mockResolvedValue({
      pushed: ['feat/a'],
      created: [],
      updated: ['feat/a'],
      webOpened: [],
      scope: { kind: 'downstack' },
      dryRun: false,
    });

    await postMerge('/repo', { all: true, restack: false, submit: true });

    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(mockCheckoutBranch).toHaveBeenCalledWith('feat/a', '/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('feat/c', '/repo');
  });

  it('journals reparent + delete ops before mutating state and clears on success', async () => {
    await postMerge('/repo', {
      restack: false,
      submit: false,
    });

    expect(mockStartCleanupJournal).toHaveBeenCalledWith('/repo');
    // feat/a is the merged-bottom branch; feat/b is its child that gets
    // reparented onto main.
    expect(mockAppendCleanupOperation).toHaveBeenNthCalledWith(
      1,
      '/repo',
      expect.anything(),
      {
        type: 'reparent',
        branch: 'feat/b',
        oldParent: 'feat/a',
        newParent: 'main',
      },
    );
    expect(mockAppendCleanupOperation).toHaveBeenNthCalledWith(
      2,
      '/repo',
      expect.anything(),
      { type: 'delete', branch: 'feat/a', reason: 'merged-pr' },
    );
    // Journal cleared after writeState succeeds.
    expect(mockClearCleanupJournal).toHaveBeenCalledWith('/repo');
    const writeStateCallOrder = mockWriteState.mock.invocationCallOrder[0];
    const clearJournalCallOrder =
      mockClearCleanupJournal.mock.invocationCallOrder[0];
    expect(writeStateCallOrder).toBeLessThan(clearJournalCallOrder);
  });

  it('does not start a journal in dry-run', async () => {
    await postMerge('/repo', { dryRun: true });

    expect(mockStartCleanupJournal).not.toHaveBeenCalled();
    expect(mockAppendCleanupOperation).not.toHaveBeenCalled();
    expect(mockClearCleanupJournal).not.toHaveBeenCalled();
  });

  it('journals each PR retarget alongside the reparent + delete ops', async () => {
    await postMerge('/repo', {
      restack: false,
      submit: false,
    });

    // The retarget op for feat/b is appended by retargetOpenPrBranches once the
    // post-merge journal is threaded in. Earlier appends are reparent + delete.
    const appendCalls = mockAppendCleanupOperation.mock.calls.map(
      (call) => call[2],
    );
    expect(appendCalls).toContainEqual({
      type: 'retarget',
      branch: 'feat/b',
      newBase: 'main',
    });
    const retargetAppendIdx = appendCalls.findIndex(
      (op) => op.type === 'retarget',
    );
    const retargetCallOrder =
      mockRetargetPrBase.mock.invocationCallOrder[0] ?? 0;
    const appendCallOrder =
      mockAppendCleanupOperation.mock.invocationCallOrder[retargetAppendIdx];
    expect(appendCallOrder).toBeLessThan(retargetCallOrder);
  });

  it('leaves the journal in place when retargetPrBase fails mid-loop', async () => {
    mockRetargetPrBase.mockRejectedValueOnce(new Error('gh edit failed'));

    await expect(
      postMerge('/repo', { restack: false, submit: false }),
    ).rejects.toThrow('gh edit failed');
    expect(mockStartCleanupJournal).toHaveBeenCalled();
    // Append for the retarget op must have happened before the throw, so the
    // op survives on disk for `dub continue` to replay.
    const appendCalls = mockAppendCleanupOperation.mock.calls.map(
      (call) => call[2],
    );
    expect(appendCalls.some((op) => op.type === 'retarget')).toBe(true);
    // Journal stays on disk: clear must not be called when retarget throws.
    expect(mockClearCleanupJournal).not.toHaveBeenCalled();
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('leaves the journal in place when writeState fails so dub continue can resume', async () => {
    mockWriteState.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      postMerge('/repo', { restack: false, submit: false }),
    ).rejects.toThrow('disk full');
    expect(mockStartCleanupJournal).toHaveBeenCalled();
    // Journal stays on disk: clearCleanupJournal must not be called when
    // writeState throws.
    expect(mockClearCleanupJournal).not.toHaveBeenCalled();
  });
});
