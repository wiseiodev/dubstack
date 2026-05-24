import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/git.js', () => ({
  branchExists: vi.fn(),
  fetchBranches: vi.fn(),
  getCurrentBranch: vi.fn(),
  getRefSha: vi.fn(),
  isAncestor: vi.fn(),
  remoteBranchExists: vi.fn(),
}));

vi.mock('../lib/github.js', () => ({
  getBranchPrSyncInfo: vi.fn(),
}));

vi.mock('../lib/operation-state.js', () => ({
  detectActiveOperation: vi.fn(),
}));

vi.mock('../lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state.js')>();
  return {
    ...actual,
    readState: vi.fn(),
  };
});

vi.mock('../lib/stack-overview.js', () => ({
  getStackOverviewBatch: vi.fn(),
  readStackOverviewCache: vi.fn(),
}));

import {
  branchExists,
  fetchBranches,
  getCurrentBranch,
  getRefSha,
  isAncestor,
  remoteBranchExists,
} from '../lib/git';
import { getBranchPrSyncInfo } from '../lib/github';
import { detectActiveOperation } from '../lib/operation-state';
import {
  getStackOverviewBatch,
  readStackOverviewCache,
} from '../lib/stack-overview';
import type { DubState } from '../lib/state';
import { readState } from '../lib/state';
import {
  formatStatus,
  type PrSnapshot,
  type StatusResult,
  status,
} from './status';

const mockBranchExists = branchExists as ReturnType<typeof vi.fn>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetRefSha = getRefSha as ReturnType<typeof vi.fn>;
const mockIsAncestor = isAncestor as ReturnType<typeof vi.fn>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockGetBranchPrSyncInfo = getBranchPrSyncInfo as ReturnType<typeof vi.fn>;
const mockDetectActiveOperation = detectActiveOperation as ReturnType<
  typeof vi.fn
>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockGetStackOverviewBatch = getStackOverviewBatch as ReturnType<
  typeof vi.fn
>;
const mockReadStackOverviewCache = readStackOverviewCache as ReturnType<
  typeof vi.fn
>;

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
        })),
      },
    ],
  };
}

function makeOverviewEntry(
  branch: string,
  overrides: Partial<{
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE';
    baseRefName: string | null;
    title: string;
    isDraft: boolean;
    ciRollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
    reviewDecision: string | null;
  }> = {},
) {
  return {
    branch,
    parent: null,
    isRoot: false,
    pr: {
      number: overrides.number ?? 42,
      title: overrides.title ?? 'add feature',
      state: overrides.state ?? 'OPEN',
      baseRefName: overrides.baseRefName ?? 'main',
      mergedAt: null,
      reviewDecision: overrides.reviewDecision ?? null,
      ciRollup: overrides.ciRollup ?? 'SUCCESS',
      isDraft: overrides.isDraft ?? false,
    },
    commit: null,
    prLink: null,
    lastSyncedAt: null,
    syncSource: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentBranch.mockResolvedValue('feat/a');
  mockDetectActiveOperation.mockResolvedValue('none');
  mockFetchBranches.mockResolvedValue(undefined);
  mockBranchExists.mockResolvedValue(true);
  mockRemoteBranchExists.mockResolvedValue(true);
  mockGetBranchPrSyncInfo.mockResolvedValue({
    state: 'NONE',
    baseRefName: null,
  });
  mockGetRefSha.mockImplementation(async (ref: string) => `${ref}-sha`);
  mockIsAncestor.mockResolvedValue(true);
  mockReadStackOverviewCache.mockResolvedValue(null);
  mockGetStackOverviewBatch.mockResolvedValue({
    branches: [],
    truncated: false,
    cachedAt: new Date().toISOString(),
  });
});

describe('status (cached path)', () => {
  it('returns cached: true with rich PR data when overview cache is present', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockReadStackOverviewCache.mockResolvedValue({
      branches: [makeOverviewEntry('feat/a', { number: 123, state: 'OPEN' })],
      truncated: false,
      cachedAt: new Date().toISOString(),
    });

    const result = await status('/repo');

    expect(result.schemaVersion).toBe(1);
    expect(result.cached).toBe(true);
    expect(result.currentBranch).toBe('feat/a');
    expect(result.pr).toEqual({
      state: 'OPEN',
      baseRefName: 'main',
      number: 123,
      title: 'add feature',
      isDraft: false,
      ciRollup: 'SUCCESS',
      reviewDecision: null,
    });
    expect(result.drift).toEqual({ healthy: true, issues: [] });
    expect(mockGetStackOverviewBatch).not.toHaveBeenCalled();
    expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
  });

  it('returns pr.state NONE when current branch is missing from cached overview', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/loose');
    mockReadState.mockResolvedValue(
      makeState([{ name: 'main', parent: null, type: 'root' }]),
    );
    mockReadStackOverviewCache.mockResolvedValue({
      branches: [makeOverviewEntry('feat/other', { number: 1 })],
      truncated: false,
      cachedAt: new Date().toISOString(),
    });

    const result = await status('/repo');

    expect(result.cached).toBe(true);
    expect(result.pr).toEqual({
      state: 'NONE',
      baseRefName: null,
      number: null,
      title: null,
      isDraft: null,
      ciRollup: null,
      reviewDecision: null,
    });
  });
});

describe('status (cold path)', () => {
  it('returns local-only snapshot with cached: false and never touches the network', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    const result = await status('/repo');

    expect(result.cached).toBe(false);
    expect(result.pr).toBeNull();
    expect(result.drift).toBeNull();
    expect(result.schemaVersion).toBe(1);
    expect(result.currentBranch).toBe('feat/a');
    expect(mockGetStackOverviewBatch).not.toHaveBeenCalled();
    expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
  });

  it('skips PR fetch entirely when pr: false', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    const result = await status('/repo', { pr: false });

    expect(result.pr).toBeNull();
    expect(result.drift).toBeNull();
    expect(mockGetBranchPrSyncInfo).not.toHaveBeenCalled();
  });
});

describe('status (live path)', () => {
  it('refreshes the overview cache and includes drift', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockGetStackOverviewBatch.mockResolvedValue({
      branches: [
        makeOverviewEntry('feat/a', {
          number: 7,
          state: 'OPEN',
          ciRollup: 'PENDING',
          isDraft: true,
        }),
      ],
      truncated: false,
      cachedAt: new Date().toISOString(),
    });

    const result = await status('/repo', { live: true });

    expect(result.cached).toBe(false);
    expect(mockGetStackOverviewBatch).toHaveBeenCalledWith('/repo', {
      refresh: true,
    });
    expect(result.pr?.number).toBe(7);
    expect(result.pr?.isDraft).toBe(true);
    expect(result.pr?.ciRollup).toBe('PENDING');
    expect(result.drift).toEqual({ healthy: true, issues: [] });
    expect(mockReadStackOverviewCache).not.toHaveBeenCalled();
  });
});

describe('status cache-only performance', () => {
  it('cached read completes well under 100ms (mocked I/O)', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockReadStackOverviewCache.mockResolvedValue({
      branches: [makeOverviewEntry('feat/a')],
      truncated: false,
      cachedAt: new Date().toISOString(),
    });

    const start = performance.now();
    await status('/repo');
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

describe('formatStatus', () => {
  const baseCached: StatusResult = {
    schemaVersion: 1,
    cached: true,
    currentBranch: 'feat/api',
    operation: 'none',
    branch: {
      tracked: true,
      stackId: 'stack-1',
      root: 'main',
      parent: 'main',
      children: [],
    },
    pr: {
      state: 'OPEN',
      baseRefName: 'main',
      number: 123,
      title: 'add feature',
      isDraft: false,
      ciRollup: 'SUCCESS',
      reviewDecision: null,
    },
    drift: { healthy: true, issues: [] },
  };

  it('renders branch + PR + CI + drift check', () => {
    expect(formatStatus(baseCached)).toBe(
      'feat/api · PR #123 OPEN · CI SUCCESS · ✓',
    );
  });

  it('renders DRAFT label when PR is a draft', () => {
    expect(
      formatStatus({
        ...baseCached,
        pr: { ...(baseCached.pr as PrSnapshot), isDraft: true },
      }),
    ).toBe('feat/api · PR #123 DRAFT · CI SUCCESS · ✓');
  });

  it('renders no PR + drift warning', () => {
    expect(
      formatStatus({
        ...baseCached,
        pr: {
          state: 'NONE',
          baseRefName: null,
          number: null,
          title: null,
          isDraft: null,
          ciRollup: null,
          reviewDecision: null,
        },
        drift: {
          healthy: false,
          issues: [
            {
              code: 'remote-drift',
              summary: 's',
              details: 'd',
              fixes: [],
            },
          ],
        },
      }),
    ).toBe('feat/api · no PR · ⚠ 1 drift issue(s)');
  });

  it('renders (cold) when no PR and no drift were computed', () => {
    expect(
      formatStatus({
        ...baseCached,
        cached: false,
        pr: null,
        drift: null,
      }),
    ).toBe('feat/api · (cold)');
  });

  it('flags an active operation', () => {
    expect(formatStatus({ ...baseCached, operation: 'restack' })).toContain(
      'restack in progress',
    );
  });
});
