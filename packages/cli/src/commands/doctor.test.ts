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
import { doctor } from './doctor';

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

describe('doctor', () => {
  it('reports a clean bill of health for a linear synced path', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await doctor('/repo');
    expect(result.healthy).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('detects active operations, missing tracked branches, and drift', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockDetectActiveOperation.mockResolvedValue('restack');
    mockBranchExists.mockImplementation(
      async (name: string) => name !== 'feat/b',
    );
    mockRemoteBranchExists.mockResolvedValue(true);
    mockGetRefSha
      .mockResolvedValueOnce('local-a')
      .mockResolvedValueOnce('remote-a')
      .mockResolvedValueOnce('same-sha')
      .mockResolvedValueOnce('same-sha');

    const result = await doctor('/repo');
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain('operation-in-progress');
    expect(codes).toContain('missing-local');
    expect(codes).toContain('remote-drift');
    expect(result.healthy).toBe(false);
  });

  it('does not flag branching stacks as a doctor issue', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'main' },
      ]),
    );
    mockGetRefSha.mockResolvedValue('same-sha');

    const result = await doctor('/repo');
    expect(result.issues).toEqual([]);
    expect(result.healthy).toBe(true);
  });

  it('reports a child branch that matches remote but is no longer based on its parent', async () => {
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockGetRefSha.mockImplementation(async (ref: string) => {
      switch (ref) {
        case 'feat/a':
        case 'origin/feat/a':
          return 'parent-new-sha';
        case 'feat/b':
        case 'origin/feat/b':
          return 'child-remote-sha';
        default:
          return `${ref}-sha`;
      }
    });
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'parent-new-sha' && right === 'child-remote-sha') {
        return false;
      }
      return true;
    });

    const result = await doctor('/repo');
    const issue = result.issues.find(
      (entry) => entry.code === 'parent-mismatch',
    );

    expect(issue?.summary).toContain(
      "Branch 'feat/b' is no longer based on 'feat/a'",
    );
    expect(issue?.details).toContain('structural stack drift');
    expect(issue?.fixes[0]).toBe('dub restack');
    expect(issue?.fixes).toContain('dub doctor');
    expect(result.healthy).toBe(false);
  });

  it('reports a branch that is still based on its local parent but no longer based on the remote PR base', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/hub-performance-streaming');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'docs/parity-pulse', parent: 'main' },
        {
          name: 'feat/hub-performance-streaming',
          parent: 'docs/parity-pulse',
        },
      ]),
    );
    mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
      if (branch === 'feat/hub-performance-streaming') {
        return {
          state: 'OPEN',
          baseRefName: 'main',
        };
      }
      return {
        state: 'NONE',
        baseRefName: null,
      };
    });
    mockGetRefSha.mockImplementation(async (ref: string) => {
      switch (ref) {
        case 'docs/parity-pulse':
          return 'docs-remote-sha';
        case 'feat/hub-performance-streaming':
        case 'origin/feat/hub-performance-streaming':
          return 'tip-sha';
        case 'main':
          return 'main-local-sha';
        case 'origin/main':
          return 'main-remote-sha';
        default:
          return `${ref}-sha`;
      }
    });
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'docs-remote-sha' && right === 'tip-sha') {
        return true;
      }
      if (left === 'main-remote-sha' && right === 'tip-sha') {
        return false;
      }
      return true;
    });

    const result = await doctor('/repo');
    const issue = result.issues.find(
      (entry) => entry.code === 'remote-base-mismatch',
    );

    expect(issue?.summary).toContain(
      "Branch 'feat/hub-performance-streaming' is not based on GitHub base 'main'",
    );
    expect(issue?.details).toContain('GitHub is evaluating this PR against');
    expect(issue?.fixes[0]).toBe(
      'git checkout main && git pull --ff-only origin main',
    );
    expect(issue?.fixes).toContain('dub restack');
    expect(issue?.fixes).toContain('dub submit --path current');
    expect(result.healthy).toBe(false);
  });

  it('fetches the GitHub base ref before checking remote-base mismatch', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/hub-performance-streaming');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        {
          name: 'feat/hub-performance-streaming',
          parent: 'main',
        },
      ]),
    );
    const fetchedRefs = new Set<string>();
    mockGetBranchPrSyncInfo.mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'release/1.95',
    });
    mockFetchBranches.mockImplementation(async (refs: string[]) => {
      for (const ref of refs) fetchedRefs.add(ref);
    });
    mockRemoteBranchExists.mockImplementation(async (branch: string) => {
      if (branch === 'release/1.95') {
        return fetchedRefs.has('release/1.95');
      }
      return true;
    });
    mockGetRefSha.mockImplementation(async (ref: string) => {
      switch (ref) {
        case 'feat/hub-performance-streaming':
        case 'origin/feat/hub-performance-streaming':
          return 'tip-sha';
        case 'main':
          return 'main-local-sha';
        case 'origin/release/1.95':
          return 'release-remote-sha';
        default:
          return `${ref}-sha`;
      }
    });
    mockIsAncestor.mockImplementation(async (left: string, right: string) => {
      if (left === 'main-local-sha' && right === 'tip-sha') {
        return true;
      }
      if (left === 'release-remote-sha' && right === 'tip-sha') {
        return false;
      }
      return true;
    });

    const result = await doctor('/repo');
    const issue = result.issues.find(
      (entry) => entry.code === 'remote-base-mismatch',
    );

    expect(mockFetchBranches).toHaveBeenCalledWith(
      expect.arrayContaining(['release/1.95']),
      '/repo',
    );
    expect(issue?.summary).toContain(
      "Branch 'feat/hub-performance-streaming' is not based on GitHub base 'release/1.95'",
    );
  });

  it('surfaces a remote-check-failed issue when the GitHub base query fails', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/hub-performance-streaming');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        {
          name: 'feat/hub-performance-streaming',
          parent: 'main',
        },
      ]),
    );
    mockGetBranchPrSyncInfo.mockRejectedValue(new Error('gh auth failed'));

    const result = await doctor('/repo');
    const issue = result.issues.find(
      (entry) => entry.code === 'remote-check-failed',
    );

    expect(issue?.summary).toContain(
      "Could not query GitHub PR info for 'feat/hub-performance-streaming'.",
    );
    expect(issue?.details).toContain('gh auth failed');
    expect(issue?.fixes).toContain('gh auth status');
    expect(issue?.fixes).toContain('gh auth login');
    expect(result.healthy).toBe(false);
  });
});
