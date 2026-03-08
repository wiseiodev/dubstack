import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getBranchTip, getCurrentBranch } from '../lib/git';
import { readState, writeState } from '../lib/state';
import { readUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { init } from './init';
import { restack, restackContinue } from './restack';

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
  await cleanup();
});

describe('restack', () => {
  it('returns up-to-date when stack needs no rebasing', async () => {
    await create('feat/a', dir);

    const result = await restack(dir);
    expect(result.status).toBe('up-to-date');
    expect(result.rebased).toHaveLength(0);
  });

  it('rebases a child branch after parent gets new commits', async () => {
    await create('feat/a', dir);

    // Add a commit on feat/a so the branch has content
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    // Go back to main and add a commit
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);

    // Go to feat/a and restack
    await gitInRepo(dir, ['checkout', 'feat/a']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/a');

    // Verify feat/a now has both files
    expect(fs.existsSync(path.join(dir, 'base.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'feat.txt'))).toBe(true);
  });

  it('rebases a chain without duplicating parent commits', async () => {
    // Create main → feat/a → feat/b
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a-commit']);

    await create('feat/b', dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'b-commit']);

    // Add a commit to main
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'main.txt'), 'main');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main-commit']);

    // Restack from feat/b
    await gitInRepo(dir, ['checkout', 'feat/b']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/a');
    expect(result.rebased).toContain('feat/b');

    // Critical: verify feat/b doesn't have duplicate commits from feat/a
    const logOutput = (
      await gitInRepo(dir, ['log', '--oneline', 'feat/b'])
    ).stdout.trim();
    const lines = logOutput.split('\n');
    const commitMessages = lines.map((l) => l.split(' ').slice(1).join(' '));

    // Should have: init, main-commit, a-commit, b-commit (no duplicates)
    const aCommitCount = commitMessages.filter((m) => m === 'a-commit').length;
    expect(aCommitCount).toBe(1);
  });

  it('throws on dirty working tree', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');

    await expect(restack(dir)).rejects.toThrow('uncommitted changes');
  });

  it('throws when branch is not in any stack', async () => {
    // main is not in any stack when there are no stacks
    await expect(restack(dir)).rejects.toThrow('not part of any stack');
  });

  it('throws when a branch in state is missing from git', async () => {
    await create('feat/a', dir);

    // Delete the branch from git but keep it in state
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['branch', '-D', 'feat/a']);

    await expect(restack(dir)).rejects.toThrow('no longer exists');
  });

  it('saves undo entry with pre-rebase branch tips', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    const preTip = await getBranchTip('feat/a', dir);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);
    await gitInRepo(dir, ['checkout', 'feat/a']);

    await restack(dir);

    const entry = await readUndoEntry(dir);
    expect(entry.operation).toBe('restack');
    expect(entry.branchTips['feat/a']).toBe(preTip);
  });

  it('restores original branch after restack', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);
    await gitInRepo(dir, ['checkout', 'feat/a']);

    await restack(dir);

    expect(await getCurrentBranch(dir)).toBe('feat/a');
  });

  it('uses parent_revision as parentOldTip when set', async () => {
    // create stores parent_revision automatically
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    // Record the parent_revision stored by create
    const state = await readState(dir);
    const branch = state.stacks[0].branches.find((b) => b.name === 'feat/a');
    expect(branch?.parent_revision).toBeTruthy();

    // Add commit to main so restack has work to do
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);

    await gitInRepo(dir, ['checkout', 'feat/a']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/a');
    expect(fs.existsSync(path.join(dir, 'base.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'feat.txt'))).toBe(true);
  });

  it('falls back to getMergeBase when parent_revision is absent', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    // Clear parent_revision from state to force getMergeBase fallback
    const state = await readState(dir);
    const branch = state.stacks[0].branches.find((b) => b.name === 'feat/a');
    if (branch) {
      branch.parent_revision = null;
    }
    await writeState(state, dir);

    // Add commit to main
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);

    await gitInRepo(dir, ['checkout', 'feat/a']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/a');
    expect(fs.existsSync(path.join(dir, 'base.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'feat.txt'))).toBe(true);
  });

  it('updates parent_revision in state after successful restack', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    // Add commit to main so restack has work to do
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);

    const mainTipAfterCommit = await getBranchTip('main', dir);

    await gitInRepo(dir, ['checkout', 'feat/a']);
    const result = await restack(dir);
    expect(result.status).toBe('success');

    // parent_revision should now be main's new tip
    const state = await readState(dir);
    const branch = state.stacks[0].branches.find((b) => b.name === 'feat/a');
    expect(branch?.parent_revision).toBe(mainTipAfterCommit);
  });

  it('updates parent_revision for each branch in a chain after restack', async () => {
    // Create main → feat/a → feat/b
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a-commit']);

    await create('feat/b', dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'b-commit']);

    // Add commit to main
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'main.txt'), 'main');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main-commit']);

    const mainTip = await getBranchTip('main', dir);

    await gitInRepo(dir, ['checkout', 'feat/b']);
    const result = await restack(dir);
    expect(result.status).toBe('success');

    const state = await readState(dir);
    const branchA = state.stacks[0].branches.find((b) => b.name === 'feat/a');
    const branchB = state.stacks[0].branches.find((b) => b.name === 'feat/b');

    // feat/a's parent_revision should be main's new tip
    expect(branchA?.parent_revision).toBe(mainTip);
    // feat/b's parent_revision should be feat/a's new tip (after rebase)
    const featATip = await getBranchTip('feat/a', dir);
    expect(branchB?.parent_revision).toBe(featATip);
  });

  it('restacks all stacks when on root branch', async () => {
    // Create two separate stacks from main
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a-commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'b-commit']);

    // Add commit to main
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'main.txt'), 'main');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main-commit']);

    // Restack from main (should restack both stacks)
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/a');
    expect(result.rebased).toContain('feat/b');
  });
});

describe('squash-merge-then-restack', () => {
  it('produces no false conflicts after squash-merge', async () => {
    // Create main → feat/a with a commit on file-a.txt
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'file-a.txt'), 'feature a content');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'add file-a']);

    // Create feat/a → feat/b with a commit on file-b.txt (different file)
    await create('feat/b', dir);
    fs.writeFileSync(path.join(dir, 'file-b.txt'), 'feature b content');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'add file-b']);

    // Simulate squash-merge of feat/a into main
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['merge', '--squash', 'feat/a']);
    await gitInRepo(dir, ['commit', '-m', 'squash A']);
    await gitInRepo(dir, ['branch', '-D', 'feat/a']);

    // Post-merge cleanup: remove feat/a from state, reparenting feat/b to main
    const state = await readState(dir);
    const stack = state.stacks[0];
    const deletedBranch = stack.branches.find((b) => b.name === 'feat/a');
    expect(deletedBranch).toBeTruthy();
    const newParent = deletedBranch?.parent ?? null;
    for (const branch of stack.branches) {
      if (branch.parent === 'feat/a') {
        branch.parent = newParent;
      }
    }
    stack.branches = stack.branches.filter((b) => b.name !== 'feat/a');
    await writeState(state, dir);

    // Restack from main (feat/b is now a child of main)
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/b');

    // Verify feat/b only has its own commit(s) on top of main
    const logOutput = (
      await gitInRepo(dir, ['log', '--oneline', 'main..feat/b'])
    ).stdout.trim();
    const lines = logOutput.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('add file-b');

    // Verify feat/b has both files (file-a from squash on main, file-b from its own commit)
    await gitInRepo(dir, ['checkout', 'feat/b']);
    expect(fs.existsSync(path.join(dir, 'file-a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'file-b.txt'))).toBe(true);
  });

  it('backward compat — restack works when parent_revision is absent', async () => {
    // Create main → feat/a → feat/b
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'file-a.txt'), 'feature a content');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'add file-a']);

    await create('feat/b', dir);
    fs.writeFileSync(path.join(dir, 'file-b.txt'), 'feature b content');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'add file-b']);

    // Simulate squash-merge of feat/a into main
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['merge', '--squash', 'feat/a']);
    await gitInRepo(dir, ['commit', '-m', 'squash A']);
    await gitInRepo(dir, ['branch', '-D', 'feat/a']);

    // Remove feat/a from state, reparent feat/b to main
    const state = await readState(dir);
    const stack = state.stacks[0];
    const deletedBranch = stack.branches.find((b) => b.name === 'feat/a');
    const newParent = deletedBranch?.parent ?? null;
    for (const branch of stack.branches) {
      if (branch.parent === 'feat/a') {
        branch.parent = newParent;
      }
    }
    stack.branches = stack.branches.filter((b) => b.name !== 'feat/a');

    // Clear parent_revision to test backward compat fallback
    const featB = stack.branches.find((b) => b.name === 'feat/b');
    if (featB) {
      featB.parent_revision = undefined;
    }
    await writeState(state, dir);

    // Restack should not crash (falls back to getMergeBase)
    await expect(restack(dir)).resolves.not.toThrow();
  });

  it('normal restack updates parent_revision after rebasing', async () => {
    // Create main → feat/a with parent_revision set
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    // Add new commit to main
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'main-new.txt'), 'new main content');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main-new-commit']);

    const mainNewTip = await getBranchTip('main', dir);

    // Restack
    await gitInRepo(dir, ['checkout', 'feat/a']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toContain('feat/a');

    // parent_revision should be updated to main's new tip
    const state = await readState(dir);
    const branch = state.stacks[0].branches.find((b) => b.name === 'feat/a');
    expect(branch?.parent_revision).toBe(mainNewTip);
  });
});

describe('restackContinue', () => {
  it('throws when no restack is in progress', async () => {
    await expect(restackContinue(dir)).rejects.toThrow(
      'No restack in progress',
    );
  });
});
