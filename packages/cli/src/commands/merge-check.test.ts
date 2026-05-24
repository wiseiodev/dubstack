import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getPr: vi.fn(),
  getPrByNumber: vi.fn(),
  getPrMergeStatusByNumber: vi.fn(),
  getPrStateByNumber: vi.fn(),
}));

vi.mock('../lib/git.js', () => ({
  getCurrentBranch: vi.fn(),
}));

vi.mock('../lib/state.js', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/state.js')>('../lib/state.js');
  return {
    ...actual,
    readState: vi.fn(),
    findStackForBranch: vi.fn(),
  };
});

import { getCurrentBranch } from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getPr,
  getPrByNumber,
  getPrMergeStatusByNumber,
  getPrStateByNumber,
} from '../lib/github';
import { findStackForBranch, readState } from '../lib/state';
import { mergeCheck } from './merge-check';

const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockGetPrByNumber = getPrByNumber as ReturnType<typeof vi.fn>;
const mockGetPrMergeStatusByNumber = getPrMergeStatusByNumber as ReturnType<
  typeof vi.fn
>;
const mockGetPrStateByNumber = getPrStateByNumber as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockFindStackForBranch = findStackForBranch as ReturnType<typeof vi.fn>;

function dubstackBody(prevPr: number | null, pr: number): string {
  return [
    'body',
    '<!-- dubstack-metadata',
    `{ "stack_id":"x","pr_number":${pr},"prev_pr":${prevPr},"next_pr":null,"branch":"feat/x" }`,
    '-->',
  ].join('\n');
}

function makePr(
  number: number,
  body: string = dubstackBody(null, number),
): {
  number: number;
  url: string;
  title: string;
  body: string;
} {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `feat: pr-${number}`,
    body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockGetCurrentBranch.mockResolvedValue('feat/a');
  mockGetPr.mockResolvedValue({
    number: 11,
    url: 'https://github.com/o/r/pull/11',
    title: 'feat: a',
    body: 'plain body',
  });
  mockGetPrByNumber.mockResolvedValue({
    number: 11,
    url: 'https://github.com/o/r/pull/11',
    title: 'feat: a',
    body: 'plain body',
  });
  mockGetPrMergeStatusByNumber.mockResolvedValue({
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  });
  mockGetPrStateByNumber.mockResolvedValue('MERGED');
});

describe('mergeCheck (single-PR mode)', () => {
  it('passes when PR is not a DubStack PR', async () => {
    const result = await mergeCheck('/repo', { pr: 11 });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('No DubStack metadata');
    expect(result.scope).toBe('current');
    expect(result.branches).toHaveLength(1);
  });

  it('passes when previous PR is already merged', async () => {
    mockGetPrByNumber.mockResolvedValue({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 'feat: b',
      body: dubstackBody(11, 12),
    });
    mockGetPrStateByNumber.mockResolvedValue('MERGED');

    const result = await mergeCheck('/repo', { pr: 12 });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('merge order satisfied');
  });

  it('fails when previous PR is not merged yet', async () => {
    mockGetPrByNumber.mockResolvedValue({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 'feat: b',
      body: dubstackBody(11, 12),
    });
    mockGetPrStateByNumber.mockResolvedValue('OPEN');

    await expect(mergeCheck('/repo', { pr: 12 })).rejects.toThrow(
      'cannot be merged yet',
    );
  });

  it('fails when GitHub reports the PR is conflicting', async () => {
    mockGetPrByNumber.mockResolvedValue({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 'feat: b',
      body: dubstackBody(11, 12),
    });
    mockGetPrStateByNumber.mockResolvedValue('MERGED');
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    });

    await expect(mergeCheck('/repo', { pr: 12 })).rejects.toThrow(
      'PR #12 is not mergeable on GitHub',
    );
  });

  it('fails when GitHub mergeability is not explicitly safe', async () => {
    mockGetPrByNumber.mockResolvedValue({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 'feat: b',
      body: dubstackBody(11, 12),
    });
    mockGetPrStateByNumber.mockResolvedValue('MERGED');
    mockGetPrMergeStatusByNumber.mockResolvedValue({
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
    });

    await expect(mergeCheck('/repo', { pr: 12 })).rejects.toThrow(
      "GitHub reports mergeable='UNKNOWN' and mergeStateStatus='BLOCKED'",
    );
  });
});

describe('mergeCheck (scoped, tree-shaped stack)', () => {
  // main -> feat/a -> { feat/b1, feat/b2, feat/b3 }
  const treeBranches = [
    { name: 'main', type: 'root' as const, parent: null },
    { name: 'feat/a', parent: 'main' },
    { name: 'feat/b1', parent: 'feat/a' },
    { name: 'feat/b2', parent: 'feat/a' },
    { name: 'feat/b3', parent: 'feat/a' },
  ];

  beforeEach(() => {
    mockReadState.mockResolvedValue({
      stacks: [{ id: 'tree', branches: treeBranches }],
    });
    mockFindStackForBranch.mockReturnValue({
      id: 'tree',
      branches: treeBranches,
    });
    mockGetCurrentBranch.mockResolvedValue('feat/b2');
  });

  it('downstack scope walks current branch + ancestors only', async () => {
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') return makePr(101, dubstackBody(null, 101));
      if (branch === 'feat/b2') return makePr(102, dubstackBody(101, 102));
      return null;
    });

    const result = await mergeCheck('/repo', { scope: 'downstack' });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('downstack');
    expect(result.branches.map((b) => b.branch)).toEqual(['feat/a', 'feat/b2']);
  });

  it('stack scope walks every non-root branch including siblings', async () => {
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') return makePr(101, dubstackBody(null, 101));
      if (branch === 'feat/b1') return makePr(201, dubstackBody(101, 201));
      if (branch === 'feat/b2') return makePr(202, dubstackBody(101, 202));
      if (branch === 'feat/b3') return makePr(203, dubstackBody(101, 203));
      return null;
    });

    const result = await mergeCheck('/repo', { scope: 'stack' });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('stack');
    expect(result.branches.map((b) => b.branch)).toEqual([
      'feat/a',
      'feat/b1',
      'feat/b2',
      'feat/b3',
    ]);
  });

  it('aggregates per-branch findings when multiple branches in scope fail', async () => {
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/a') return makePr(101, dubstackBody(null, 101));
      if (branch === 'feat/b1') return makePr(201, dubstackBody(101, 201));
      if (branch === 'feat/b2') return makePr(202, dubstackBody(101, 202));
      if (branch === 'feat/b3') return makePr(203, dubstackBody(101, 203));
      return null;
    });
    mockGetPrStateByNumber.mockImplementation(async (prNumber: number) => {
      // PR 101 (feat/a, the root stack PR) is OPEN, so b1/b2/b3 fail.
      if (prNumber === 101) return 'OPEN';
      return 'MERGED';
    });

    await expect(mergeCheck('/repo', { scope: 'stack' })).rejects.toThrow(
      '3 of 4 branch(es) cannot merge yet',
    );
  });

  it("scope 'current' (default) checks only the current branch", async () => {
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/b2') return makePr(202, dubstackBody(101, 202));
      return null;
    });

    const result = await mergeCheck('/repo');
    expect(result.scope).toBe('current');
    expect(result.branches.map((b) => b.branch)).toEqual(['feat/b2']);
  });

  it('explicit --branch overrides scope walking', async () => {
    mockGetPr.mockImplementation(async (branch: string) => {
      if (branch === 'feat/b1') return makePr(201, dubstackBody(null, 201));
      return null;
    });

    const result = await mergeCheck('/repo', {
      branch: 'feat/b1',
      scope: 'stack',
    });
    expect(result.branches.map((b) => b.branch)).toEqual(['feat/b1']);
  });
});
