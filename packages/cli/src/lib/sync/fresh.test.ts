import { describe, expect, it } from 'vitest';
import type { Branch } from '../state';
import { FRESH_SYNC_WINDOW_MS, partitionFreshBranches } from './fresh';

function makeBranchMap(
  entries: Array<{ name: string; lastSyncedAt: string | null }>,
): Map<string, Branch> {
  const map = new Map<string, Branch>();
  for (const entry of entries) {
    map.set(entry.name, {
      name: entry.name,
      parent: null,
      pr_number: null,
      pr_link: null,
      last_synced_at: entry.lastSyncedAt,
    });
  }
  return map;
}

describe('partitionFreshBranches', () => {
  const now = Date.parse('2026-05-23T12:00:00.000Z');

  it('marks branches with no last_synced_at as mustFetch', () => {
    const branchMap = makeBranchMap([{ name: 'feat/a', lastSyncedAt: null }]);
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a']);
    expect(result.canSkip).toEqual([]);
  });

  it('marks recently-synced branches as canSkip', () => {
    const branchMap = makeBranchMap([
      {
        name: 'feat/a',
        lastSyncedAt: new Date(now - 60_000).toISOString(),
      },
    ]);
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.canSkip).toEqual(['feat/a']);
    expect(result.mustFetch).toEqual([]);
  });

  it('marks branches older than the window as mustFetch', () => {
    const branchMap = makeBranchMap([
      {
        name: 'feat/a',
        lastSyncedAt: new Date(now - FRESH_SYNC_WINDOW_MS - 1).toISOString(),
      },
    ]);
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a']);
    expect(result.canSkip).toEqual([]);
  });

  it('treats the window boundary as expired', () => {
    const branchMap = makeBranchMap([
      {
        name: 'feat/a',
        lastSyncedAt: new Date(now - FRESH_SYNC_WINDOW_MS).toISOString(),
      },
    ]);
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a']);
  });

  it('treats future timestamps as mustFetch (clock skew guard)', () => {
    const branchMap = makeBranchMap([
      {
        name: 'feat/a',
        lastSyncedAt: new Date(now + 60_000).toISOString(),
      },
    ]);
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a']);
  });

  it('treats unparseable timestamps as mustFetch', () => {
    const branchMap = makeBranchMap([
      { name: 'feat/a', lastSyncedAt: 'not-a-date' },
    ]);
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a']);
  });

  it('fresh=true forces all branches into mustFetch', () => {
    const branchMap = makeBranchMap([
      {
        name: 'feat/a',
        lastSyncedAt: new Date(now - 1000).toISOString(),
      },
      {
        name: 'feat/b',
        lastSyncedAt: new Date(now - 1000).toISOString(),
      },
    ]);
    const result = partitionFreshBranches({
      branches: ['feat/a', 'feat/b'],
      branchMap,
      fresh: true,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a', 'feat/b']);
    expect(result.canSkip).toEqual([]);
  });

  it('returns missing branches as mustFetch', () => {
    const branchMap = new Map<string, Branch>();
    const result = partitionFreshBranches({
      branches: ['feat/a'],
      branchMap,
      fresh: false,
      now,
    });
    expect(result.mustFetch).toEqual(['feat/a']);
  });
});
