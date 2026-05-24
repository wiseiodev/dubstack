import { describe, expect, it } from 'vitest';
import { createSubTreeTagger } from '../../src/commands/submit';
import type { Stack } from '../../src/lib/state';

function makeStack(
  branches: Array<{ name: string; parent: string | null; root?: boolean }>,
): Stack {
  return {
    id: 'test-stack',
    branches: branches.map((b) => ({
      name: b.name,
      parent: b.parent,
      type: b.root ? 'root' : undefined,
      pr_number: null,
      pr_link: null,
    })),
  };
}

describe('createSubTreeTagger', () => {
  it('returns the branch name unchanged in a linear stack', () => {
    const stack = makeStack([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
      { name: 'feat/b', parent: 'feat/a' },
      { name: 'feat/c', parent: 'feat/b' },
    ]);
    const tag = createSubTreeTagger(stack, 'main');

    expect(tag('feat/a')).toBe('feat/a');
    expect(tag('feat/b')).toBe('feat/b');
    expect(tag('feat/c')).toBe('feat/c');
  });

  it('does not prefix branches that sit directly on trunk', () => {
    const stack = makeStack([
      { name: 'main', parent: null, root: true },
      { name: 'feat/auth-base', parent: 'main' },
      { name: 'feat/dashboard', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(stack, 'main');

    expect(tag('feat/auth-base')).toBe('feat/auth-base');
    expect(tag('feat/dashboard')).toBe('feat/dashboard');
  });

  it('prefixes descendants with the deepest ancestor that has siblings', () => {
    const stack = makeStack([
      { name: 'main', parent: null, root: true },
      { name: 'feat/auth-base', parent: 'main' },
      { name: 'feat/auth-login', parent: 'feat/auth-base' },
      { name: 'feat/auth-logout', parent: 'feat/auth-base' },
      { name: 'feat/dashboard', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(stack, 'main');

    expect(tag('feat/auth-login')).toBe('feat/auth-base · feat/auth-login');
    expect(tag('feat/auth-logout')).toBe('feat/auth-base · feat/auth-logout');
    expect(tag('feat/auth-base')).toBe('feat/auth-base');
    expect(tag('feat/dashboard')).toBe('feat/dashboard');
  });

  it('uses the deepest forked ancestor, not the trunk-child', () => {
    // main → top → {leftBranch → leftLeaf, rightBranch → rightLeaf}
    // For leftLeaf the deepest ancestor with siblings is leftBranch
    // (its sibling is rightBranch), not top.
    const stack = makeStack([
      { name: 'main', parent: null, root: true },
      { name: 'top', parent: 'main' },
      { name: 'leftBranch', parent: 'top' },
      { name: 'leftLeaf', parent: 'leftBranch' },
      { name: 'rightBranch', parent: 'top' },
      { name: 'rightLeaf', parent: 'rightBranch' },
    ]);
    const tag = createSubTreeTagger(stack, 'main');

    expect(tag('leftLeaf')).toBe('leftBranch · leftLeaf');
    expect(tag('rightLeaf')).toBe('rightBranch · rightLeaf');
    // leftBranch & rightBranch are forks themselves; their only non-trunk
    // ancestor (`top`) has no siblings, so they get no prefix.
    expect(tag('leftBranch')).toBe('leftBranch');
    expect(tag('rightBranch')).toBe('rightBranch');
    expect(tag('top')).toBe('top');
  });

  it('returns the branch unchanged when the fork is at the branch itself', () => {
    // main → A → {B, C}. B and C are forks but their ancestor A is unique;
    // skip the prefix because the branch name already differentiates.
    const stack = makeStack([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
      { name: 'feat/b', parent: 'feat/a' },
      { name: 'feat/c', parent: 'feat/a' },
    ]);
    const tag = createSubTreeTagger(stack, 'main');

    expect(tag('feat/b')).toBe('feat/b');
    expect(tag('feat/c')).toBe('feat/c');
  });

  it('returns the branch unchanged for unknown branches', () => {
    const stack = makeStack([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(stack, 'main');

    expect(tag('feat/missing')).toBe('feat/missing');
  });
});
