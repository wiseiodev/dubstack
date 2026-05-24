import { describe, expect, it } from 'vitest';
import type { Branch } from '../lib/state';
import { createSubTreeTagger } from './submit';

function makeBranches(
  entries: Array<{ name: string; parent: string | null; root?: boolean }>,
): Branch[] {
  return entries.map((b) => ({
    name: b.name,
    parent: b.parent,
    type: b.root ? 'root' : undefined,
    pr_number: null,
    pr_link: null,
  }));
}

describe('createSubTreeTagger', () => {
  it('returns the branch name unchanged in a linear stack', () => {
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
      { name: 'feat/b', parent: 'feat/a' },
      { name: 'feat/c', parent: 'feat/b' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('feat/a')).toBe('feat/a');
    expect(tag('feat/b')).toBe('feat/b');
    expect(tag('feat/c')).toBe('feat/c');
  });

  it('does not prefix branches that sit directly on trunk', () => {
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'feat/auth-base', parent: 'main' },
      { name: 'feat/dashboard', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('feat/auth-base')).toBe('feat/auth-base');
    expect(tag('feat/dashboard')).toBe('feat/dashboard');
  });

  it('prefixes descendants with the deepest ancestor that has siblings', () => {
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'feat/auth-base', parent: 'main' },
      { name: 'feat/auth-login', parent: 'feat/auth-base' },
      { name: 'feat/auth-logout', parent: 'feat/auth-base' },
      { name: 'feat/dashboard', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('feat/auth-login')).toBe('feat/auth-base · feat/auth-login');
    expect(tag('feat/auth-logout')).toBe('feat/auth-base · feat/auth-logout');
    expect(tag('feat/auth-base')).toBe('feat/auth-base');
    expect(tag('feat/dashboard')).toBe('feat/dashboard');
  });

  it('uses the deepest forked ancestor, not the trunk-child', () => {
    // main → top → {leftBranch → leftLeaf, rightBranch → rightLeaf}
    // For leftLeaf the deepest ancestor with siblings is leftBranch
    // (its sibling is rightBranch), not top.
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'top', parent: 'main' },
      { name: 'leftBranch', parent: 'top' },
      { name: 'leftLeaf', parent: 'leftBranch' },
      { name: 'rightBranch', parent: 'top' },
      { name: 'rightLeaf', parent: 'rightBranch' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('leftLeaf')).toBe('leftBranch · leftLeaf');
    expect(tag('rightLeaf')).toBe('rightBranch · rightLeaf');
    // leftBranch & rightBranch are forks themselves; their only non-trunk
    // ancestor (`top`) has no siblings, so they get no prefix.
    expect(tag('leftBranch')).toBe('leftBranch');
    expect(tag('rightBranch')).toBe('rightBranch');
    expect(tag('top')).toBe('top');
  });

  it('returns the branch unchanged when no ancestor has siblings', () => {
    // main → A → {B, C}. B and C are siblings of each other, but their only
    // non-trunk ancestor (A) has no siblings itself. The walk starts at A,
    // finds A has no siblings, walks to A's parent (trunk), and exits.
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
      { name: 'feat/b', parent: 'feat/a' },
      { name: 'feat/c', parent: 'feat/a' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('feat/b')).toBe('feat/b');
    expect(tag('feat/c')).toBe('feat/c');
  });

  it('returns the branch unchanged for unknown branches', () => {
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('feat/missing')).toBe('feat/missing');
  });

  it('returns the root branch name unchanged', () => {
    const branches = makeBranches([
      { name: 'main', parent: null, root: true },
      { name: 'feat/a', parent: 'main' },
      { name: 'feat/b', parent: 'main' },
    ]);
    const tag = createSubTreeTagger(branches, 'main');

    expect(tag('main')).toBe('main');
  });

  it('handles the "(unknown)" trunk fallback without producing wrong tags', () => {
    // `getSubmitPlan` falls back to rootBranch = '(unknown)' when no branch
    // is marked as root. The early-exit guard `branch.parent === trunkName`
    // then never fires, but the walk still terminates at the topmost ancestor
    // because that ancestor's `.parent` is null. Confirm we don't accidentally
    // prefix a branch whose ancestor chain has no real siblings.
    const branches = makeBranches([
      { name: 'feat/a', parent: null },
      { name: 'feat/b', parent: 'feat/a' },
      { name: 'feat/c', parent: 'feat/a' },
    ]);
    const tag = createSubTreeTagger(branches, '(unknown)');

    expect(tag('feat/b')).toBe('feat/b');
    expect(tag('feat/c')).toBe('feat/c');
  });
});
