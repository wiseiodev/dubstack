import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getBranchTip, getCurrentBranch } from '../lib/git';
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

describe('restackContinue', () => {
  it('throws when no restack is in progress', async () => {
    await expect(restackContinue(dir)).rejects.toThrow(
      'No restack in progress',
    );
  });
});
