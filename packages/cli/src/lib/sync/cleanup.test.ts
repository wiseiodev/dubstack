import { describe, expect, it, vi } from 'vitest';
import { buildCleanupPlan } from './cleanup';

describe('buildCleanupPlan', () => {
  it('marks merged PR branch cleanable without requiring ancestry', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('MERGED'),
      isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
    });

    expect(result.toDelete).toEqual([
      { branch: 'feat/a', reason: 'merged-pr' },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('skips closed PR branch when commits are not in trunk', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('CLOSED'),
      isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
    });

    expect(result.toDelete).toEqual([]);
    expect(result.skipped).toEqual([
      {
        branch: 'feat/a',
        reason: 'commits-not-in-trunk',
      },
    ]);
  });

  it('skips branch with no merged/closed PR', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('OPEN'),
      isMergedIntoAnyRoot: vi.fn(),
    });

    expect(result.toDelete).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('cleans up NONE-PR branches detected as merged by patch-id', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('NONE'),
      isMergedIntoAnyRoot: vi.fn(),
      isMergedByPatchId: vi.fn().mockResolvedValue(true),
    });

    expect(result.toDelete).toEqual([
      { branch: 'feat/a', reason: 'merged-by-patch-id' },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('leaves NONE-PR branches alone when patch-id detection finds no match', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('NONE'),
      isMergedIntoAnyRoot: vi.fn(),
      isMergedByPatchId: vi.fn().mockResolvedValue(false),
    });

    expect(result.toDelete).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('preserves prior behavior when no patch-id fallback is provided', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('NONE'),
      isMergedIntoAnyRoot: vi.fn(),
    });

    expect(result.toDelete).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('handles mixed lifecycle states across multiple branches', async () => {
    const statuses = new Map<string, 'OPEN' | 'CLOSED' | 'MERGED'>([
      ['feat/a', 'MERGED'],
      ['feat/b', 'CLOSED'],
      ['feat/c', 'OPEN'],
      ['feat/d', 'CLOSED'],
    ]);
    const mergedIntoRoot = new Set<string>(['feat/b']);
    const result = await buildCleanupPlan({
      branches: ['feat/a', 'feat/b', 'feat/c', 'feat/d'],
      getPrStatus: vi.fn((branch: string) =>
        Promise.resolve(statuses.get(branch) ?? 'OPEN'),
      ),
      isMergedIntoAnyRoot: vi.fn((branch: string) =>
        Promise.resolve(mergedIntoRoot.has(branch)),
      ),
    });

    expect(result.toDelete).toEqual([
      { branch: 'feat/a', reason: 'merged-pr' },
      { branch: 'feat/b', reason: 'closed-pr-merged-into-trunk' },
    ]);
    expect(result.skipped).toEqual([
      { branch: 'feat/d', reason: 'commits-not-in-trunk' },
    ]);
  });
});
