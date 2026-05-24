import { describe, expect, it } from 'vitest';
import { DubError } from './errors';
import { parseScope, resolveScopeBranches } from './scope';
import type { Branch, Stack } from './state';

function makeBranch(name: string, parent: string | null): Branch {
  return {
    name,
    parent,
    ...(parent == null ? { type: 'root' as const } : {}),
    pr_number: null,
    pr_link: null,
    last_submitted_version: null,
    last_reconciled_version: null,
    last_synced_at: null,
    sync_source: null,
  };
}

function makeTreeStack(): Stack {
  // main -> feat/a -> { feat/b1, feat/b2, feat/b3 }
  return {
    id: 'tree',
    branches: [
      makeBranch('main', null),
      makeBranch('feat/a', 'main'),
      makeBranch('feat/b1', 'feat/a'),
      makeBranch('feat/b2', 'feat/a'),
      makeBranch('feat/b3', 'feat/a'),
    ],
  };
}

describe('parseScope', () => {
  it('accepts the three documented values', () => {
    expect(parseScope('current')).toBe('current');
    expect(parseScope('downstack')).toBe('downstack');
    expect(parseScope('stack')).toBe('stack');
  });

  it('throws DubError on unknown value', () => {
    expect(() => parseScope('upstack')).toThrow(DubError);
  });
});

describe('resolveScopeBranches', () => {
  const stack = makeTreeStack();

  it("returns just the current branch for scope 'current'", () => {
    expect(
      resolveScopeBranches(stack, 'feat/b2', 'current').map((b) => b.name),
    ).toEqual(['feat/b2']);
  });

  it("returns current + ancestors for scope 'downstack'", () => {
    expect(
      resolveScopeBranches(stack, 'feat/b2', 'downstack').map((b) => b.name),
    ).toEqual(['feat/a', 'feat/b2']);
  });

  it("returns every non-root branch in topological order for scope 'stack'", () => {
    expect(
      resolveScopeBranches(stack, 'feat/b2', 'stack').map((b) => b.name),
    ).toEqual(['feat/a', 'feat/b1', 'feat/b2', 'feat/b3']);
  });

  it('returns empty list when current branch is the root', () => {
    expect(resolveScopeBranches(stack, 'main', 'current')).toEqual([]);
    expect(resolveScopeBranches(stack, 'main', 'downstack')).toEqual([]);
  });

  it('returns empty list when current branch is not in the stack', () => {
    expect(resolveScopeBranches(stack, 'feat/missing', 'current')).toEqual([]);
    expect(resolveScopeBranches(stack, 'feat/missing', 'downstack')).toEqual(
      [],
    );
  });

  it('throws DubError on a cycle in the downstack walk', () => {
    const cyclic: Stack = {
      id: 'cyclic',
      branches: [
        makeBranch('main', null),
        // feat/a → feat/b → feat/a (cycle, no root parent for the children)
        { ...makeBranch('feat/a', 'feat/b') },
        { ...makeBranch('feat/b', 'feat/a') },
      ],
    };
    expect(() => resolveScopeBranches(cyclic, 'feat/a', 'downstack')).toThrow(
      /cycle detected/,
    );
  });

  it('throws DubError when an ancestor parent is missing from the stack', () => {
    const broken: Stack = {
      id: 'broken',
      branches: [
        makeBranch('main', null),
        // feat/orphan's parent 'feat/ghost' is not in the stack
        { ...makeBranch('feat/orphan', 'feat/ghost') },
      ],
    };
    expect(() =>
      resolveScopeBranches(broken, 'feat/orphan', 'downstack'),
    ).toThrow(/missing parent branch/);
  });
});
