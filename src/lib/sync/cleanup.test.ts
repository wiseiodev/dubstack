import { describe, expect, it, vi } from 'vitest';
import { buildCleanupPlan } from './cleanup';

describe('buildCleanupPlan', () => {
  it('marks merged PR branch cleanable without requiring ancestry', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('MERGED'),
      isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
    });

    expect(result.toDelete).toEqual(['feat/a']);
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
});
