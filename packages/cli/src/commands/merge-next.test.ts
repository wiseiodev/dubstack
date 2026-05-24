import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getPr: vi.fn(),
  mergePr: vi.fn(),
  retargetPrBase: vi.fn(),
}));

vi.mock('./post-merge.js', () => ({
  postMerge: vi.fn(),
}));

vi.mock('./submit.js', () => ({
  getSubmitPlan: vi.fn(),
}));

import {
  checkGhAuth,
  ensureGhInstalled,
  getPr,
  mergePr,
  retargetPrBase,
} from '../lib/github';
import { mergeNext } from './merge-next';
import { postMerge } from './post-merge';
import { getSubmitPlan } from './submit';

const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockMergePr = mergePr as ReturnType<typeof vi.fn>;
const mockRetargetPrBase = retargetPrBase as ReturnType<typeof vi.fn>;
const mockPostMerge = postMerge as ReturnType<typeof vi.fn>;
const mockGetSubmitPlan = getSubmitPlan as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockGetSubmitPlan.mockResolvedValue({
    state: { stacks: [] },
    stack: {
      id: 'stack-1',
      branches: [
        {
          name: 'main',
          type: 'root',
          parent: null,
          pr_number: null,
          pr_link: null,
        },
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
        { name: 'feat/b', parent: 'feat/a', pr_number: null, pr_link: null },
        { name: 'feat/c', parent: 'feat/b', pr_number: null, pr_link: null },
      ],
    },
    currentBranch: 'feat/c',
    rootBranch: 'main',
    scope: { kind: 'downstack' },
    branches: [
      { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      { name: 'feat/b', parent: 'feat/a', pr_number: null, pr_link: null },
      { name: 'feat/c', parent: 'feat/b', pr_number: null, pr_link: null },
    ],
  });
  mockGetPr.mockImplementation(async (branch: string) => {
    if (branch === 'feat/a') {
      return {
        number: 101,
        url: 'https://github.com/o/r/pull/101',
        title: 'feat: a',
        body: '',
      };
    }
    if (branch === 'feat/b') {
      return {
        number: 102,
        url: 'https://github.com/o/r/pull/102',
        title: 'feat: b',
        body: '',
      };
    }
    return null;
  });
  mockMergePr.mockResolvedValue(undefined);
  mockRetargetPrBase.mockResolvedValue(undefined);
  mockPostMerge.mockResolvedValue({
    cleaned: ['feat/a'],
    skipped: [],
    reparented: [{ branch: 'feat/b', parent: 'main' }],
    retargeted: ['feat/b'],
    restacked: true,
    submitted: true,
    submittedBranches: ['feat/b', 'feat/c'],
    dryRun: false,
  });
});

describe('mergeNext', () => {
  it('retargets child PRs before merge and runs post-merge maintenance', async () => {
    const result = await mergeNext('/repo');

    expect(mockRetargetPrBase).toHaveBeenCalledWith('feat/b', 'main', '/repo');
    expect(mockRetargetPrBase.mock.invocationCallOrder[0]).toBeLessThan(
      mockMergePr.mock.invocationCallOrder[0],
    );
    expect(mockMergePr).toHaveBeenCalledWith(101, '/repo', {
      method: 'squash',
      deleteBranch: true,
    });
    expect(mockPostMerge).toHaveBeenCalledWith('/repo', {
      dryRun: false,
      restack: true,
      submit: true,
    });
    expect(result.mergedBranch).toBe('feat/a');
    expect(result.prNumber).toBe(101);
    expect(result.preMergeRetargeted).toEqual(['feat/b']);
  });

  it('supports dry-run without merging', async () => {
    const result = await mergeNext('/repo', { dryRun: true });

    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
    expect(mockPostMerge).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.mergedBranch).toBe('feat/a');
    expect(result.preMergeRetargeted).toEqual(['feat/b']);
  });

  it('throws when next branch has no open PR', async () => {
    mockGetPr.mockImplementation(async () => null);
    await expect(mergeNext('/repo')).rejects.toThrow('No open PR found');
  });

  it('aborts merge when pre-merge retargeting fails', async () => {
    mockRetargetPrBase.mockRejectedValueOnce(new Error('retarget failed'));

    await expect(mergeNext('/repo')).rejects.toThrow('retarget failed');
    expect(mockMergePr).not.toHaveBeenCalled();
  });
});
