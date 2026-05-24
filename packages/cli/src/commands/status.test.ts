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
import type { DubState } from '../lib/state';
import { readState } from '../lib/state';
import { status } from './status';

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
});

describe('status', () => {
  it('reports a tracked branch with healthy drift and PR info', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'main',
    });

    const result = await status('/repo');

    expect(result).toEqual({
      schemaVersion: 1,
      currentBranch: 'feat/a',
      operation: 'none',
      branch: {
        tracked: true,
        stackId: 'stack-1',
        root: 'main',
        parent: 'main',
        children: [],
      },
      pr: { state: 'OPEN', baseRefName: 'main' },
      drift: { healthy: true, issues: [] },
    });
  });

  it('reports an untracked branch with empty stack metadata', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/loose');
    mockReadState.mockResolvedValue(
      makeState([{ name: 'main', parent: null, type: 'root' }]),
    );

    const result = await status('/repo');

    expect(result.currentBranch).toBe('feat/loose');
    expect(result.branch).toEqual({
      tracked: false,
      stackId: null,
      root: null,
      parent: null,
      children: [],
    });
    expect(result.drift.healthy).toBe(true);
  });

  it('returns UNKNOWN pr state with error when gh auth is missing', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');
    mockGetBranchPrSyncInfo.mockRejectedValue(
      new Error('gh: not authenticated'),
    );

    const result = await status('/repo');

    expect(result.pr).toEqual({
      state: 'UNKNOWN',
      baseRefName: null,
      error: 'gh: not authenticated',
    });
    expect(result.schemaVersion).toBe(1);
  });
});
