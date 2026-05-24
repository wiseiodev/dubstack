import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getAllPrSyncInfoBatch: vi.fn(),
  getBranchPrSyncInfo: vi.fn(),
  getPr: vi.fn(),
  getPrMergeStatusByNumber: vi.fn(),
  mergePr: vi.fn(),
  retargetPrBase: vi.fn(),
}));

vi.mock('./post-merge.js', () => ({
  postMerge: vi.fn(),
}));

vi.mock('./submit.js', () => ({
  getSubmitPlan: vi.fn(),
}));

import type { Mock } from 'vitest';
import {
  checkGhAuth,
  ensureGhInstalled,
  getAllPrSyncInfoBatch,
  getBranchPrSyncInfo,
  getPr,
  getPrMergeStatusByNumber,
  mergePr,
  retargetPrBase,
} from '../lib/github';
import { mergeNext } from './merge-next';
import { postMerge } from './post-merge';
import { getSubmitPlan } from './submit';

const mockEnsureGhInstalled = ensureGhInstalled as Mock;
const mockCheckGhAuth = checkGhAuth as Mock;
const mockGetAllPrSyncInfoBatch = getAllPrSyncInfoBatch as Mock;
const mockGetBranchPrSyncInfo = getBranchPrSyncInfo as Mock;
const mockGetPr = getPr as Mock;
const mockGetPrMergeStatusByNumber = getPrMergeStatusByNumber as Mock;
const mockMergePr = mergePr as Mock;
const mockRetargetPrBase = retargetPrBase as Mock;
const mockPostMerge = postMerge as Mock;
const mockGetSubmitPlan = getSubmitPlan as Mock;

interface BranchSpec {
  name: string;
  parent: string | null;
  pr_number?: number | null;
  pr_link?: string | null;
  type?: 'root';
}

function makePlan(opts: { branches: BranchSpec[]; currentBranch: string }) {
  const branches = opts.branches.map((b) => ({
    name: b.name,
    parent: b.parent,
    pr_number: b.pr_number ?? null,
    pr_link: b.pr_link ?? null,
    ...(b.type ? { type: b.type } : {}),
  }));
  const root = branches.find((b) => b.type === 'root');
  return {
    state: { stacks: [] },
    stack: { id: 'stack-1', branches },
    currentBranch: opts.currentBranch,
    rootBranch: root?.name ?? 'main',
    path: 'stack',
    branches: branches.filter((b) => b.type !== 'root'),
  };
}

function lifecycleBatch(
  entries: Record<string, 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE'>,
  truncated = false,
) {
  const byBranch = new Map<
    string,
    { state: 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE'; baseRefName: string | null }
  >();
  for (const [name, state] of Object.entries(entries)) {
    byBranch.set(name, { state, baseRefName: null });
  }
  return { byBranch, truncated };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockGetBranchPrSyncInfo.mockResolvedValue({
    state: 'NONE',
    baseRefName: null,
  });
  mockMergePr.mockResolvedValue(undefined);
  mockRetargetPrBase.mockResolvedValue(undefined);
  mockPostMerge.mockResolvedValue({
    cleaned: [],
    skipped: [],
    reparented: [],
    retargeted: [],
    restacked: true,
    submitted: true,
    submittedBranches: [],
    dryRun: false,
  });
});

describe('mergeNext linear stack', () => {
  beforeEach(() => {
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/c',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/a', parent: 'main' },
          { name: 'feat/b', parent: 'feat/a' },
          { name: 'feat/c', parent: 'feat/b' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({
        'feat/a': 'OPEN',
        'feat/b': 'OPEN',
        'feat/c': 'NONE',
      }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a')
        return { number: 101, url: 'u/101', title: 'a', body: '' };
      if (branch === 'feat/b')
        return { number: 102, url: 'u/102', title: 'b', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockImplementation(async () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }));
  });

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
    expect(result.siblingCandidates).toEqual([]);
    expect(result.blockedSiblings).toEqual([]);
  });

  it('supports dry-run without merging', async () => {
    const result = await mergeNext('/repo', { dryRun: true });

    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
    expect(mockPostMerge).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.mergedBranch).toBe('feat/a');
    expect(result.preMergeRetargeted).toEqual(['feat/b']);
    expect(result.siblingCandidates).toEqual([]);
    expect(result.blockedSiblings).toEqual([]);
  });

  it('throws when no branch in the stack has an open PR', async () => {
    mockGetAllPrSyncInfoBatch.mockResolvedValue(lifecycleBatch({}));
    mockGetPr.mockResolvedValue(null);
    await expect(mergeNext('/repo')).rejects.toThrow(
      'No mergeable branch found in the stack.',
    );
  });

  it('aborts merge when pre-merge retargeting fails', async () => {
    mockRetargetPrBase.mockRejectedValueOnce(new Error('retarget failed'));

    await expect(mergeNext('/repo')).rejects.toThrow('retarget failed');
    expect(mockMergePr).not.toHaveBeenCalled();
  });
});

describe('mergeNext tree selection', () => {
  it('3-sibling tree: prefers branch on the current path and reports the others', async () => {
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/bravo',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/alpha', parent: 'main' },
          { name: 'feat/bravo', parent: 'main' },
          { name: 'feat/charlie', parent: 'main' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({
        'feat/alpha': 'OPEN',
        'feat/bravo': 'OPEN',
        'feat/charlie': 'OPEN',
      }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/alpha')
        return { number: 201, url: 'u/201', title: 'a', body: '' };
      if (branch === 'feat/bravo')
        return { number: 202, url: 'u/202', title: 'b', body: '' };
      if (branch === 'feat/charlie')
        return { number: 203, url: 'u/203', title: 'c', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    });

    const result = await mergeNext('/repo');

    expect(result.mergedBranch).toBe('feat/bravo');
    expect(result.prNumber).toBe(202);
    expect(result.siblingCandidates).toEqual(['feat/alpha', 'feat/charlie']);
    expect(result.blockedSiblings).toEqual([]);
    expect(mockMergePr).toHaveBeenCalledWith(202, '/repo', {
      method: 'squash',
      deleteBranch: true,
    });
  });

  it('falls back to alphabetical order when no MERGEABLE peer is on the current branch path', async () => {
    // User is on feat/zulu (a depth-1 sibling), but its PR is BLOCKED. The
    // on-current-path tie-break therefore finds no mergeable candidate and
    // we fall back to the BFS-deterministic alphabetical first.
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/zulu',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/alpha', parent: 'main' },
          { name: 'feat/bravo', parent: 'main' },
          { name: 'feat/zulu', parent: 'main' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({
        'feat/alpha': 'OPEN',
        'feat/bravo': 'OPEN',
        'feat/zulu': 'OPEN',
      }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/alpha')
        return { number: 301, url: 'u/301', title: 'a', body: '' };
      if (branch === 'feat/bravo')
        return { number: 302, url: 'u/302', title: 'b', body: '' };
      if (branch === 'feat/zulu')
        return { number: 399, url: 'u/399', title: 'z', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockImplementation(
      async (prNumber: number) => {
        if (prNumber === 399)
          return { mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED' };
        return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
      },
    );

    const result = await mergeNext('/repo');

    expect(result.mergedBranch).toBe('feat/alpha');
    expect(result.siblingCandidates).toEqual(['feat/bravo']);
    expect(result.blockedSiblings).toEqual([
      {
        branch: 'feat/zulu',
        prNumber: 399,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'BLOCKED',
      },
    ]);
  });

  it('does not descend to grandchildren when a depth-1 candidate exists', async () => {
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/grand',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/parent', parent: 'main' },
          { name: 'feat/grand', parent: 'feat/parent' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({
        'feat/parent': 'OPEN',
        'feat/grand': 'OPEN',
      }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/parent')
        return { number: 401, url: 'u/401', title: 'p', body: '' };
      if (branch === 'feat/grand')
        return { number: 402, url: 'u/402', title: 'g', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    });

    const result = await mergeNext('/repo');

    expect(result.mergedBranch).toBe('feat/parent');
    expect(mockGetPrMergeStatusByNumber).toHaveBeenCalledWith(401, '/repo');
    // Mergeability is not probed for grandchildren since depth 1 already had a winner.
    expect(mockGetPrMergeStatusByNumber).not.toHaveBeenCalledWith(402, '/repo');
  });

  it('errors cleanly and does not merge when the only depth-1 candidate is BLOCKED', async () => {
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/only',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/only', parent: 'main' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({ 'feat/only': 'OPEN' }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/only')
        return { number: 501, url: 'u/501', title: 'only', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'BLOCKED',
    });

    await expect(mergeNext('/repo')).rejects.toThrow(
      /No mergeable PR at this stack level.*feat\/only.*PR #501.*mergeable=CONFLICTING.*state=BLOCKED/,
    );
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
  });

  it('sibling hint lists only MERGEABLE peers — blocked siblings are excluded', async () => {
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/bravo',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/alpha', parent: 'main' },
          { name: 'feat/bravo', parent: 'main' },
          { name: 'feat/charlie', parent: 'main' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({
        'feat/alpha': 'OPEN',
        'feat/bravo': 'OPEN',
        'feat/charlie': 'OPEN',
      }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/alpha')
        return { number: 701, url: 'u/701', title: 'a', body: '' };
      if (branch === 'feat/bravo')
        return { number: 702, url: 'u/702', title: 'b', body: '' };
      if (branch === 'feat/charlie')
        return { number: 703, url: 'u/703', title: 'c', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockImplementation(
      async (prNumber: number) => {
        if (prNumber === 701)
          return { mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED' };
        return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
      },
    );

    const result = await mergeNext('/repo');

    expect(result.mergedBranch).toBe('feat/bravo');
    expect(result.siblingCandidates).toEqual(['feat/charlie']);
    expect(result.blockedSiblings).toEqual([
      {
        branch: 'feat/alpha',
        prNumber: 701,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'BLOCKED',
      },
    ]);
  });

  it('UNKNOWN mergeability at the lowest depth produces a distinct retry-oriented error', async () => {
    // GitHub returns mergeable=UNKNOWN while it is still computing. Treating
    // this as "blocked" would push users to chase non-existent CI/approval
    // failures. The error should tell them to retry instead.
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/only',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/only', parent: 'main' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({ 'feat/only': 'OPEN' }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/only')
        return { number: 901, url: 'u/901', title: 'o', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'UNKNOWN',
      mergeStateStatus: null,
    });

    await expect(mergeNext('/repo')).rejects.toThrow(
      /GitHub has not yet computed mergeability.*feat\/only.*PR #901.*mergeable=UNKNOWN/,
    );
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
  });

  it('does not descend past a blocked floor: depth-1 BLOCKED with mergeable descendant still errors', async () => {
    // feat/blocked is BLOCKED at depth 1. feat/grand is mergeable at depth 2.
    // Even though the eligibility guard would normally skip feat/grand
    // (parent's PR is OPEN, not MERGED), this test pins the contract: the
    // mergeable descendant must NOT be chosen, and we must surface the
    // blocked parent's status as a clean error.
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/grand',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/blocked', parent: 'main' },
          { name: 'feat/grand', parent: 'feat/blocked' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({
        'feat/blocked': 'OPEN',
        'feat/grand': 'OPEN',
      }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/blocked')
        return { number: 801, url: 'u/801', title: 'p', body: '' };
      if (branch === 'feat/grand')
        return { number: 802, url: 'u/802', title: 'g', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockImplementation(
      async (prNumber: number) => {
        if (prNumber === 801)
          return { mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED' };
        return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
      },
    );

    await expect(mergeNext('/repo')).rejects.toThrow(
      /No mergeable PR at this stack level.*feat\/blocked/,
    );
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
  });

  it('dry-run reflects the chosen target and sibling hint', async () => {
    mockGetSubmitPlan.mockResolvedValue(
      makePlan({
        currentBranch: 'feat/bravo',
        branches: [
          { name: 'main', parent: null, type: 'root' },
          { name: 'feat/alpha', parent: 'main' },
          { name: 'feat/bravo', parent: 'main' },
        ],
      }),
    );
    mockGetAllPrSyncInfoBatch.mockResolvedValue(
      lifecycleBatch({ 'feat/alpha': 'OPEN', 'feat/bravo': 'OPEN' }),
    );
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/alpha')
        return { number: 601, url: 'u/601', title: 'a', body: '' };
      if (branch === 'feat/bravo')
        return { number: 602, url: 'u/602', title: 'b', body: '' };
      return null;
    });
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    });

    const result = await mergeNext('/repo', { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.mergedBranch).toBe('feat/bravo');
    expect(result.prNumber).toBe(602);
    expect(result.siblingCandidates).toEqual(['feat/alpha']);
    expect(result.blockedSiblings).toEqual([]);
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockRetargetPrBase).not.toHaveBeenCalled();
  });
});
