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

  it('marks MERGED branches with trailing local commits as merged-pr-with-trailing-commits', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('MERGED'),
      isMergedIntoAnyRoot: vi.fn(),
      isMergedByPatchId: vi.fn().mockResolvedValue(false),
    });

    expect(result.toDelete).toEqual([
      { branch: 'feat/a', reason: 'merged-pr-with-trailing-commits' },
    ]);
  });

  it('uses plain merged-pr reason when patch-id confirms all commits in trunk', async () => {
    const result = await buildCleanupPlan({
      branches: ['feat/a'],
      getPrStatus: vi.fn().mockResolvedValue('MERGED'),
      isMergedIntoAnyRoot: vi.fn(),
      isMergedByPatchId: vi.fn().mockResolvedValue(true),
    });

    expect(result.toDelete).toEqual([
      { branch: 'feat/a', reason: 'merged-pr' },
    ]);
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

  describe('DFS-greedy with re-parenting', () => {
    it('re-parents an open child onto the grandparent when the middle is merged', async () => {
      // trunk → middle (MERGED) → child (OPEN)
      const result = await buildCleanupPlan({
        branches: ['middle', 'child'],
        parentOf: new Map<string, string | null>([
          ['middle', null],
          ['child', 'middle'],
        ]),
        getPrStatus: vi.fn(async (b: string) =>
          b === 'middle' ? 'MERGED' : 'OPEN',
        ),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
      });

      expect(result.toDelete).toEqual([
        { branch: 'middle', reason: 'merged-pr' },
      ]);
      expect(result.toReparent).toEqual([
        { branch: 'child', oldParent: 'middle', newParent: null },
      ]);
      // Reparent must precede delete so the journal records the orphan
      // rescue before the parent disappears.
      expect(result.operations.map((op) => op.type)).toEqual([
        'reparent',
        'delete',
      ]);
    });

    it('cascades reparenting through several merged ancestors', async () => {
      // trunk → m1 (MERGED) → m2 (MERGED) → leaf (OPEN)
      const result = await buildCleanupPlan({
        branches: ['m1', 'm2', 'leaf'],
        parentOf: new Map<string, string | null>([
          ['m1', null],
          ['m2', 'm1'],
          ['leaf', 'm2'],
        ]),
        getPrStatus: vi.fn(async (b: string) =>
          b === 'leaf' ? 'OPEN' : 'MERGED',
        ),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
      });

      const reparent = result.toReparent.find((op) => op.branch === 'leaf');
      expect(reparent?.newParent).toBeNull();
      expect(result.toDelete.map((d) => d.branch).sort()).toEqual(['m1', 'm2']);
    });

    it('does not delete an empty branch with no PR by default', async () => {
      const result = await buildCleanupPlan({
        branches: ['feat/placeholder'],
        parentOf: new Map<string, string | null>([['feat/placeholder', null]]),
        getPrStatus: vi.fn().mockResolvedValue('NONE'),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
        isEmpty: vi.fn().mockResolvedValue(true),
      });

      expect(result.toDelete).toEqual([]);
      expect(result.toReparent).toEqual([]);
    });

    it('deletes an empty branch with no PR when --force is set', async () => {
      const result = await buildCleanupPlan({
        branches: ['feat/placeholder'],
        parentOf: new Map<string, string | null>([['feat/placeholder', null]]),
        force: true,
        getPrStatus: vi.fn().mockResolvedValue('NONE'),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
        isEmpty: vi.fn().mockResolvedValue(true),
      });

      expect(result.toDelete).toEqual([
        { branch: 'feat/placeholder', reason: 'empty-branch' },
      ]);
    });

    it('deletes an empty branch with an OPEN PR without --force', async () => {
      const result = await buildCleanupPlan({
        branches: ['feat/empty-pr'],
        parentOf: new Map<string, string | null>([['feat/empty-pr', null]]),
        getPrStatus: vi.fn().mockResolvedValue('OPEN'),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
        isEmpty: vi.fn().mockResolvedValue(true),
      });

      expect(result.toDelete).toEqual([
        { branch: 'feat/empty-pr', reason: 'empty-branch' },
      ]);
    });

    it('keeps a non-empty open branch alone (no delete, no reparent)', async () => {
      const result = await buildCleanupPlan({
        branches: ['feat/a'],
        parentOf: new Map<string, string | null>([['feat/a', null]]),
        getPrStatus: vi.fn().mockResolvedValue('OPEN'),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
        isEmpty: vi.fn().mockResolvedValue(false),
      });

      expect(result.operations).toEqual([]);
    });

    it('greedy-deletes a chain when both ancestor and child are merged', async () => {
      // trunk → m1 (MERGED) → m2 (MERGED). No remaining children to block.
      const result = await buildCleanupPlan({
        branches: ['m1', 'm2'],
        parentOf: new Map<string, string | null>([
          ['m1', null],
          ['m2', 'm1'],
        ]),
        getPrStatus: vi.fn().mockResolvedValue('MERGED'),
        isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
      });

      // Bottom-up delete: m2 must be removed before m1 so we never delete an
      // ancestor that still claims a child branch.
      expect(result.toDelete.map((d) => d.branch)).toEqual(['m2', 'm1']);
    });
  });
});
