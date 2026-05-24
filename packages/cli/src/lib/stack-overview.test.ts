import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo } from '../../test/helpers';

vi.mock('./git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git.js')>();
  return {
    ...actual,
    getBranchCommitMetaBatch: vi.fn(),
  };
});

vi.mock('./github.js', () => ({
  getStackOverviewPrBatch: vi.fn(),
}));

import { getBranchCommitMetaBatch } from './git';
import { getStackOverviewPrBatch } from './github';
import { getStackOverviewBatch, OVERVIEW_CACHE_TTL_MS } from './stack-overview';
import {
  addBranchToStack,
  type DubState,
  initState,
  writeState,
} from './state';

const mockGetBranchCommitMetaBatch = getBranchCommitMetaBatch as ReturnType<
  typeof vi.fn
>;
const mockGetStackOverviewPrBatch = getStackOverviewPrBatch as ReturnType<
  typeof vi.fn
>;

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await initState(dir);
  vi.clearAllMocks();
});

afterEach(async () => {
  await cleanup();
});

async function seedTrivialStack(): Promise<void> {
  const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
  const raw = fs.readFileSync(statePath, 'utf-8');
  const state = JSON.parse(raw) as DubState;
  addBranchToStack(state, 'feat/a', 'main');
  addBranchToStack(state, 'feat/b', 'feat/a');
  await writeState(state, dir);
}

const samplePr = {
  number: 7,
  title: 'feat: a',
  state: 'OPEN' as const,
  baseRefName: 'main',
  mergedAt: null,
  reviewDecision: 'APPROVED',
  ciRollup: 'SUCCESS' as const,
  isDraft: false,
};

describe('getStackOverviewBatch — fresh fetch', () => {
  it('issues one gh call + one for-each-ref and joins state', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValueOnce({
      byBranch: new Map([['feat/a', samplePr]]),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValueOnce(
      new Map([
        [
          'feat/a',
          {
            committedRel: '1 hour ago',
            authorEmail: 't@x',
            shortSha: 'abcd1234',
          },
        ],
      ]),
    );

    const overview = await getStackOverviewBatch(dir);

    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(1);
    expect(mockGetBranchCommitMetaBatch).toHaveBeenCalledTimes(1);
    expect(mockGetBranchCommitMetaBatch).toHaveBeenCalledWith(dir, [
      'main',
      'feat/a',
      'feat/b',
    ]);
    expect(overview.branches.map((b) => b.branch)).toEqual([
      'main',
      'feat/a',
      'feat/b',
    ]);
    const a = overview.branches.find((b) => b.branch === 'feat/a');
    expect(a?.pr).toEqual(samplePr);
    expect(a?.commit?.shortSha).toBe('abcd1234');
    expect(a?.parent).toBe('main');
    expect(a?.isRoot).toBe(false);
    expect(overview.branches.find((b) => b.branch === 'main')?.isRoot).toBe(
      true,
    );
    expect(overview.truncated).toBe(false);
  });

  it('returns null pr / commit for branches without a match', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValueOnce({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValueOnce(new Map());

    const overview = await getStackOverviewBatch(dir);
    for (const b of overview.branches) {
      expect(b.pr).toBeNull();
      expect(b.commit).toBeNull();
    }
  });
});

describe('getStackOverviewBatch — cache', () => {
  it('returns the cached overview on a hit without calling gh/git', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValueOnce({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValueOnce(new Map());

    const now = 1_000_000;
    const first = await getStackOverviewBatch(dir, { now: () => now });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(1);

    const second = await getStackOverviewBatch(dir, {
      now: () => now + 10_000,
    });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(1);
    expect(second.cachedAt).toBe(first.cachedAt);
  });

  it('refetches when the cache is stale', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValue({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValue(new Map());

    const now = 1_000_000;
    await getStackOverviewBatch(dir, { now: () => now });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(1);

    await getStackOverviewBatch(dir, {
      now: () => now + OVERVIEW_CACHE_TTL_MS + 1,
    });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(2);
  });

  it('refetches when refresh: true even if the cache is fresh', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValue({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValue(new Map());

    const now = 1_000_000;
    await getStackOverviewBatch(dir, { now: () => now });
    await getStackOverviewBatch(dir, {
      now: () => now + 100,
      refresh: true,
    });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(2);
  });

  it('writes the cache to .git/dubstack/overview-cache.json', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValueOnce({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValueOnce(new Map());

    await getStackOverviewBatch(dir);

    const cachePath = path.join(dir, '.git', 'dubstack', 'overview-cache.json');
    expect(fs.existsSync(cachePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(typeof parsed.cachedAt).toBe('string');
    expect(Array.isArray(parsed.branches)).toBe(true);
  });

  it('ignores a future-dated cache (negative age)', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValue({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValue(new Map());

    const future = 5_000_000;
    await getStackOverviewBatch(dir, { now: () => future });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(1);

    await getStackOverviewBatch(dir, { now: () => future - 60_000 });
    expect(mockGetStackOverviewPrBatch).toHaveBeenCalledTimes(2);
  });
});

describe('getStackOverviewBatch — cache write failure', () => {
  it('returns the overview even when the cache write fails', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValueOnce({
      byBranch: new Map(),
      truncated: false,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValueOnce(new Map());

    // Pre-create the cache path as a directory so fs.writeFile fails
    // (you can't write a file over a directory). State + PR + commit
    // fetches all succeed; only the cache write breaks.
    const cachePath = path.join(dir, '.git', 'dubstack', 'overview-cache.json');
    fs.mkdirSync(cachePath, { recursive: true });

    const overview = await getStackOverviewBatch(dir, { refresh: true });
    expect(overview.branches.length).toBeGreaterThan(0);
  });
});

describe('getStackOverviewBatch — truncation passthrough', () => {
  it('surfaces truncated:true from getStackOverviewPrBatch', async () => {
    await seedTrivialStack();
    mockGetStackOverviewPrBatch.mockResolvedValueOnce({
      byBranch: new Map(),
      truncated: true,
    });
    mockGetBranchCommitMetaBatch.mockResolvedValueOnce(new Map());

    const overview = await getStackOverviewBatch(dir);
    expect(overview.truncated).toBe(true);
  });
});
