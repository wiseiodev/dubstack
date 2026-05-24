import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { DubError } from '../lib/errors';
import { getBranchTip, hasStagedChanges } from '../lib/git';
import { readUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { init } from './init';
import { pop } from './pop';
import { undo } from './undo';

let dir: string;
let cleanup: () => Promise<void>;

async function writeAndCommit(
  cwd: string,
  file: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(cwd, file), contents);
  await gitInRepo(cwd, ['add', file]);
  await gitInRepo(cwd, ['commit', '-m', message]);
}

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

describe('pop', () => {
  it('pops one commit and leaves changes staged', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'first', 'feat: first commit');
    const tip = await getBranchTip('feat/a', dir);

    const result = await pop(dir, {});

    expect(result.steps).toBe(1);
    expect(result.previousTip).toBe(tip);
    expect(await getBranchTip('feat/a', dir)).not.toBe(tip);
    expect(await hasStagedChanges(dir)).toBe(true);

    const { stdout } = await gitInRepo(dir, [
      'diff',
      '--cached',
      '--name-only',
    ]);
    expect(stdout.trim()).toBe('a.txt');
  });

  it('pops N commits and squashes them into the staging area', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');
    await writeAndCommit(dir, 'c.txt', '3', 'feat: c3');

    await pop(dir, { steps: 3 });

    const { stdout } = await gitInRepo(dir, [
      'diff',
      '--cached',
      '--name-only',
    ]);
    const staged = stdout.trim().split('\n').sort();
    expect(staged).toEqual(['a.txt', 'b.txt', 'c.txt']);

    const { stdout: log } = await gitInRepo(dir, [
      'log',
      '--oneline',
      'main..feat/a',
    ]);
    expect(log.trim()).toBe('');
  });

  it('refuses to pop when branch has no commits above parent', async () => {
    await create('feat/a', dir);

    await expect(pop(dir, {})).rejects.toThrow(
      "Nothing to pop: 'feat/a' has no commits above 'main'",
    );
  });

  it('refuses to pop past the parent branch', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: only commit');

    await expect(pop(dir, { steps: 2 })).rejects.toThrow(DubError);
    await expect(pop(dir, { steps: 2 })).rejects.toThrow(
      "'feat/a' has only 1 commit(s) above 'main'",
    );
  });

  it('refuses to pop when working tree has uncommitted changes', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');

    await expect(pop(dir, {})).rejects.toThrow('uncommitted changes');
  });

  it('refuses when steps is not a positive integer', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await expect(pop(dir, { steps: 0 })).rejects.toThrow(
      'Steps must be a positive integer',
    );
    await expect(pop(dir, { steps: -1 })).rejects.toThrow(
      'Steps must be a positive integer',
    );
  });

  it('writes an undo entry that restores the popped commit', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'first', 'feat: first');
    const preTip = await getBranchTip('feat/a', dir);

    await pop(dir, {});

    const entry = await readUndoEntry(dir);
    expect(entry.operation).toBe('pop');
    expect(entry.branchTips['feat/a']).toBe(preTip);
    expect(entry.previousBranch).toBe('feat/a');
  });

  it('refuses on a branch without a tracked parent', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'untracked']);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');

    await expect(pop(dir, {})).rejects.toThrow(
      'Could not determine parent branch',
    );
  });
});

describe('undo pop', () => {
  it('restores the popped commit and discards staged changes', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'first', 'feat: first');
    const preTip = await getBranchTip('feat/a', dir);

    await pop(dir, {});
    expect(await hasStagedChanges(dir)).toBe(true);

    const result = await undo(dir);

    expect(result.undone).toBe('pop');
    expect(await getBranchTip('feat/a', dir)).toBe(preTip);
    expect(await hasStagedChanges(dir)).toBe(false);
  });

  it('refuses to undo a pop if the user modified a tracked file', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'first', 'feat: first');
    await writeAndCommit(dir, 'tracked.txt', 'original', 'feat: tracked');

    await pop(dir, {});
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'edited');

    await expect(undo(dir)).rejects.toThrow('uncommitted changes');
  });

  it('allows undo of a pop with untracked files present (hard-reset preserves them)', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'first', 'feat: first');
    const preTip = await getBranchTip('feat/a', dir);

    await pop(dir, {});
    fs.writeFileSync(path.join(dir, 'scratch.log'), 'temp');

    const result = await undo(dir);
    expect(result.undone).toBe('pop');
    expect(await getBranchTip('feat/a', dir)).toBe(preTip);
    expect(fs.existsSync(path.join(dir, 'scratch.log'))).toBe(true);
  });

  it('refuses to undo a pop from a different branch', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'first', 'feat: first');

    await pop(dir, {});
    // Stash the staged pop output so we can leave the branch cleanly.
    await gitInRepo(dir, ['stash', 'push', '--staged', '-m', 'pop']);
    await gitInRepo(dir, ['checkout', 'main']);

    await expect(undo(dir)).rejects.toThrow(
      "Cannot undo pop: currently on 'main', expected 'feat/a'",
    );
  });
});
