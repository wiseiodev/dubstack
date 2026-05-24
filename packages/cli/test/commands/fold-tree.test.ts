import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '../../src/commands/create';
import { fold } from '../../src/commands/fold';
import { init } from '../../src/commands/init';
import { getBranchTip } from '../../src/lib/git';
import * as github from '../../src/lib/github';
import { findStackForBranch, readState, writeState } from '../../src/lib/state';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', 'init dubstack']);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

async function commitFile(
  filename: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(dir, filename), contents);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', message]);
}

function getBranch(state: Awaited<ReturnType<typeof readState>>, name: string) {
  return findStackForBranch(state, name)?.branches.find((b) => b.name === name);
}

async function listBranches(): Promise<string[]> {
  const { stdout } = await gitInRepo(dir, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/',
  ]);
  return stdout.split('\n').filter(Boolean).sort();
}

describe('dub fold', () => {
  it('folds a leaf branch into its non-trunk parent (keep-commits)', async () => {
    // main → feat/base → feat/child (leaf)
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    const result = await fold(dir, { force: true });

    expect(result.cancelled).toBe(false);
    expect(result.branch).toBe('feat/child');
    expect(result.parent).toBe('feat/base');
    expect(result.childrenReparented).toEqual([]);
    expect(result.squashedCommits).toBe(1);

    // feat/child branch is gone locally
    const branches = await listBranches();
    expect(branches).not.toContain('feat/child');
    expect(branches).toContain('feat/base');

    // feat/base now contains the child commit
    const log = (
      await gitInRepo(dir, ['log', '--oneline', 'feat/base'])
    ).stdout.trim();
    expect(log).toContain('child-commit');
    expect(log).toContain('base-commit');

    // State has no feat/child anymore
    const state = await readState(dir);
    expect(getBranch(state, 'feat/child')).toBeUndefined();
    expect(getBranch(state, 'feat/base')).toBeDefined();
  });

  it('re-parents children of folded branch onto the grandparent', async () => {
    // main → feat/base → feat/mid → {feat/leaf1, feat/leaf2}
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/mid', dir);
    await commitFile('mid.txt', 'mid', 'mid-commit');

    await create('feat/leaf1', dir);
    await commitFile('leaf1.txt', 'leaf1', 'leaf1-commit');

    await gitInRepo(dir, ['checkout', 'feat/mid']);
    await create('feat/leaf2', dir);
    await commitFile('leaf2.txt', 'leaf2', 'leaf2-commit');

    await gitInRepo(dir, ['checkout', 'feat/mid']);

    const result = await fold(dir, { force: true });

    expect(result.branch).toBe('feat/mid');
    expect(result.parent).toBe('feat/base');
    expect(result.childrenReparented.sort()).toEqual([
      'feat/leaf1',
      'feat/leaf2',
    ]);
    expect(result.restacked).toBe(true);

    const state = await readState(dir);
    expect(getBranch(state, 'feat/mid')).toBeUndefined();
    expect(getBranch(state, 'feat/leaf1')?.parent).toBe('feat/base');
    expect(getBranch(state, 'feat/leaf2')?.parent).toBe('feat/base');

    const newBaseTip = await getBranchTip('feat/base', dir);
    expect(getBranch(state, 'feat/leaf1')?.parent_revision).toBe(newBaseTip);
    expect(getBranch(state, 'feat/leaf2')?.parent_revision).toBe(newBaseTip);

    // Both leaves still contain their own commits + the folded mid-commit
    for (const branch of ['feat/leaf1', 'feat/leaf2']) {
      const log = (await gitInRepo(dir, ['log', '--oneline', branch])).stdout;
      expect(log).toContain('mid-commit');
      expect(log).toContain('base-commit');
    }
  });

  it('--squash mode rebases descendants onto the new squash commit', async () => {
    // main → feat/base → feat/mid → feat/leaf
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/mid', dir);
    await commitFile('m1.txt', 'm1', 'mid-1');
    await commitFile('m2.txt', 'm2', 'mid-2');

    await create('feat/leaf', dir);
    await commitFile('leaf.txt', 'leaf', 'leaf-commit');

    await gitInRepo(dir, ['checkout', 'feat/mid']);

    const result = await fold(dir, { force: true, squash: true });

    expect(result.restacked).toBe(true);
    expect(result.squashedCommits).toBe(2);

    const newBaseTip = await getBranchTip('feat/base', dir);
    const leafParentSha = (
      await gitInRepo(dir, ['rev-parse', 'feat/leaf^'])
    ).stdout.trim();
    // feat/leaf's immediate parent commit must be the new squash commit on
    // feat/base — otherwise leaf is orphaned on the dead branch tip.
    expect(leafParentSha).toBe(newBaseTip);

    // leaf still has all the squashed work in its history
    const log = (await gitInRepo(dir, ['log', '--oneline', 'feat/leaf']))
      .stdout;
    expect(log).toContain('leaf-commit');

    const state = await readState(dir);
    expect(getBranch(state, 'feat/leaf')?.parent).toBe('feat/base');
    expect(getBranch(state, 'feat/leaf')?.parent_revision).toBe(newBaseTip);
  });

  it('--squash mode collapses commits into one on the parent', async () => {
    // main → feat/base → feat/child (with 3 commits)
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('a.txt', 'a', 'child-a');
    await commitFile('b.txt', 'b', 'child-b');
    await commitFile('c.txt', 'c', 'child-c');

    const result = await fold(dir, { force: true, squash: true });

    expect(result.squashedCommits).toBe(3);

    // Count commits on feat/base post-fold using rev-list (one SHA per commit,
    // not per message line). Pre-fold parent has: [init, init dubstack,
    // base-commit] = 3; squash adds exactly one more commit.
    const postFold = (
      await gitInRepo(dir, ['rev-list', '--count', 'feat/base'])
    ).stdout.trim();
    expect(Number(postFold)).toBe(4);

    // Squashed commit subject = first commit's subject
    const subject = (
      await gitInRepo(dir, ['log', '-1', '--format=%s', 'feat/base'])
    ).stdout.trim();
    expect(subject).toBe('child-a');

    // All three files exist on feat/base
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'c.txt'))).toBe(true);
  });

  it('closes the PR with a comment when the folded branch had an OPEN PR', async () => {
    const closePrSpy = vi
      .spyOn(github, 'closePrWithComment')
      .mockResolvedValue(undefined);
    vi.spyOn(github, 'ensureGhInstalled').mockResolvedValue(undefined);
    vi.spyOn(github, 'checkGhAuth').mockResolvedValue(undefined);
    vi.spyOn(github, 'getPrStateByNumber').mockResolvedValue('OPEN');

    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    // Attach a PR to feat/child in state
    const state = await readState(dir);
    const child = getBranch(state, 'feat/child');
    if (!child) throw new Error('expected feat/child in state');
    child.pr_number = 42;
    child.pr_link = 'https://github.com/owner/repo/pull/42';
    await writeState(state, dir);

    const result = await fold(dir, { force: true });

    expect(result.prClosed).toBe(true);
    expect(result.prNumber).toBe(42);
    expect(closePrSpy).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Folded into `feat/base`'),
      dir,
    );
  });

  it('does not close PR when it is already merged or closed', async () => {
    const closePrSpy = vi
      .spyOn(github, 'closePrWithComment')
      .mockResolvedValue(undefined);
    vi.spyOn(github, 'ensureGhInstalled').mockResolvedValue(undefined);
    vi.spyOn(github, 'checkGhAuth').mockResolvedValue(undefined);
    vi.spyOn(github, 'getPrStateByNumber').mockResolvedValue('MERGED');

    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    const state = await readState(dir);
    const child = getBranch(state, 'feat/child');
    if (!child) throw new Error('expected feat/child in state');
    child.pr_number = 99;
    await writeState(state, dir);

    const result = await fold(dir, { force: true });

    expect(result.prClosed).toBe(false);
    expect(closePrSpy).not.toHaveBeenCalled();
  });

  it('rejects fold when current branch is directly on trunk', async () => {
    await create('feat/onTrunk', dir);
    await commitFile('x.txt', 'x', 'x-commit');

    await expect(fold(dir, { force: true })).rejects.toThrow(
      /Cannot fold 'feat\/onTrunk' into trunk 'main'/,
    );
  });

  it('rejects fold when branch is not up to date with parent', async () => {
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    // Advance feat/base after the child branched off (simulates drift)
    await gitInRepo(dir, ['checkout', 'feat/base']);
    await commitFile('extra.txt', 'extra', 'base-extra-commit');

    await gitInRepo(dir, ['checkout', 'feat/child']);

    await expect(fold(dir, { force: true })).rejects.toThrow(
      /not up to date with parent/,
    );
  });

  it('rejects fold without --force in non-interactive mode', async () => {
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    await expect(fold(dir, { interactive: false })).rejects.toThrow(
      /Fold requires confirmation/,
    );
  });

  it('rejects fold on a branch with no commits to fold', async () => {
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    // child branch with no commits of its own
    await create('feat/empty', dir);

    await expect(fold(dir, { force: true })).rejects.toThrow(
      /has no commits to fold/,
    );
  });

  it('rejects fold on a root branch', async () => {
    // Track main as a root by creating any child branch first.
    await create('feat/anything', dir);
    await commitFile('x.txt', 'x', 'x-commit');

    await expect(fold(dir, { branch: 'main', force: true })).rejects.toThrow(
      /Cannot fold root branch 'main'/,
    );
  });

  it('rejects fold when the target branch is checked out in another worktree', async () => {
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    // Switch off feat/child first — `git worktree add <p> feat/child`
    // refuses if feat/child is already checked out anywhere.
    await gitInRepo(dir, ['checkout', 'feat/base']);
    const worktreePath = path.join(
      path.dirname(dir),
      `${path.basename(dir)}-wt`,
    );
    await gitInRepo(dir, ['worktree', 'add', worktreePath, 'feat/child']);
    try {
      await expect(
        fold(dir, { branch: 'feat/child', force: true }),
      ).rejects.toThrow(/checked out in another worktree/);
    } finally {
      await gitInRepo(dir, ['worktree', 'remove', '--force', worktreePath]);
    }
  });

  it('rejects fold when working tree is dirty', async () => {
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child-commit');

    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
    await gitInRepo(dir, ['add', 'dirty.txt']);

    await expect(fold(dir, { force: true })).rejects.toThrow(
      /uncommitted changes/,
    );
  });
});
