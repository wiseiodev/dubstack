import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { DubError } from '../lib/errors';
import * as gitLib from '../lib/git';
import {
  branchExists,
  getCurrentBranch,
  readLastPushedSha,
  writeLastPushedSha,
} from '../lib/git';
import { findStackForBranch, readState } from '../lib/state';
import { readUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { init } from './init';
import { rename } from './rename';
import { undo } from './undo';

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

describe('rename', () => {
  it('renames the current tracked branch and updates state + git', async () => {
    await create('feat/old', dir);

    const result = await rename(dir, 'feat/new');

    expect(result.oldName).toBe('feat/old');
    expect(result.newName).toBe('feat/new');
    expect(result.reparentedChildren).toEqual([]);
    expect(result.pushed).toBe(false);
    expect(await getCurrentBranch(dir)).toBe('feat/new');
    expect(await branchExists('feat/old', dir)).toBe(false);
    expect(await branchExists('feat/new', dir)).toBe(true);

    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/new');
    expect(stack).toBeDefined();
    expect(stack?.branches.map((b) => b.name)).toEqual(['main', 'feat/new']);
  });

  it('renames a specific branch by old/new args', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await gitInRepo(dir, ['checkout', 'main']);

    const result = await rename(dir, 'feat/a', 'feat/a-renamed');

    expect(result.oldName).toBe('feat/a');
    expect(result.newName).toBe('feat/a-renamed');
    expect(result.reparentedChildren).toEqual(['feat/b']);

    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/a-renamed');
    expect(stack?.branches.map((b) => b.name).sort()).toEqual(
      ['feat/a-renamed', 'feat/b', 'main'].sort(),
    );
    const childB = stack?.branches.find((b) => b.name === 'feat/b');
    expect(childB?.parent).toBe('feat/a-renamed');
  });

  it('re-parents children when the renamed branch has children', async () => {
    await create('feat/parent', dir);
    await create('feat/child', dir);

    await gitInRepo(dir, ['checkout', 'feat/parent']);

    const result = await rename(dir, 'feat/parent-renamed');

    expect(result.reparentedChildren).toEqual(['feat/child']);

    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/parent-renamed');
    const child = stack?.branches.find((b) => b.name === 'feat/child');
    expect(child?.parent).toBe('feat/parent-renamed');
  });

  it('throws when the new name collides with a tracked branch', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    await gitInRepo(dir, ['checkout', 'feat/a']);

    await expect(rename(dir, 'feat/b')).rejects.toThrow(
      "Branch 'feat/b' is already tracked",
    );
    expect(await branchExists('feat/a', dir)).toBe(true);
  });

  it('throws when the new name collides with an untracked local branch', async () => {
    await create('feat/a', dir);
    await gitInRepo(dir, ['branch', 'untracked-collision']);

    await expect(rename(dir, 'untracked-collision')).rejects.toThrow(
      'already exists locally',
    );
    expect(await branchExists('feat/a', dir)).toBe(true);
  });

  it('throws on invalid new branch name', async () => {
    await create('feat/a', dir);

    await expect(rename(dir, '..bad')).rejects.toThrow(DubError);
  });

  it('throws when the source branch is not tracked', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'untracked']);

    await expect(rename(dir, 'untracked-new')).rejects.toThrow(
      'is not tracked',
    );
  });

  it('throws when targeting the root branch', async () => {
    await create('feat/a', dir);

    await expect(rename(dir, 'main', 'main-renamed')).rejects.toThrow(
      'Cannot rename root branch',
    );
  });

  it('throws when old and new are identical', async () => {
    await create('feat/a', dir);

    await expect(rename(dir, 'feat/a')).rejects.toThrow('already named');
  });

  it('saves a rename undo entry', async () => {
    await create('feat/a', dir);

    await rename(dir, 'feat/a-renamed');

    const entry = await readUndoEntry(dir);
    expect(entry.operation).toBe('rename');
    expect(entry.renameFrom).toBe('feat/a');
    expect(entry.renameTo).toBe('feat/a-renamed');
    expect(entry.previousBranch).toBe('feat/a');
  });

  it('undo restores the old branch name and parent links', async () => {
    await create('feat/parent', dir);
    await create('feat/child', dir);
    await gitInRepo(dir, ['checkout', 'feat/parent']);

    await rename(dir, 'feat/parent-renamed');
    expect(await branchExists('feat/parent-renamed', dir)).toBe(true);

    await undo(dir);

    expect(await branchExists('feat/parent', dir)).toBe(true);
    expect(await branchExists('feat/parent-renamed', dir)).toBe(false);

    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/parent');
    const child = stack?.branches.find((b) => b.name === 'feat/child');
    expect(child?.parent).toBe('feat/parent');
  });

  it('skips push when no PR is linked', async () => {
    await create('feat/a', dir);
    const pushSpy = vi.spyOn(gitLib, 'pushBranch').mockResolvedValue(undefined);

    const result = await rename(dir, 'feat/a-renamed');

    expect(result.pushed).toBe(false);
    expect(result.prNumber).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('pushes the renamed branch when a PR is linked', async () => {
    await create('feat/a', dir);
    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/a');
    const branch = stack?.branches.find((b) => b.name === 'feat/a');
    if (branch) branch.pr_number = 42;
    const { writeState } = await import('../lib/state');
    await writeState(state, dir);

    const pushSpy = vi.spyOn(gitLib, 'pushBranch').mockResolvedValue(undefined);

    const result = await rename(dir, 'feat/a-renamed');

    expect(result.pushed).toBe(true);
    expect(result.prNumber).toBe(42);
    expect(pushSpy).toHaveBeenCalledWith('feat/a-renamed', dir);
  });

  it('migrates the local last-pushed tracking ref to the new branch name', async () => {
    await create('feat/a', dir);
    const tipSha = (
      await gitInRepo(dir, ['rev-parse', 'feat/a'])
    ).stdout.trim();
    await writeLastPushedSha('feat/a', tipSha, dir);

    await rename(dir, 'feat/a-renamed');

    expect(await readLastPushedSha('feat/a-renamed', dir)).toBe(tipSha);
    expect(await readLastPushedSha('feat/a', dir)).toBeNull();
  });

  it('undo restores the last-pushed tracking ref to the old branch name', async () => {
    await create('feat/a', dir);
    const tipSha = (
      await gitInRepo(dir, ['rev-parse', 'feat/a'])
    ).stdout.trim();
    await writeLastPushedSha('feat/a', tipSha, dir);

    await rename(dir, 'feat/a-renamed');
    await undo(dir);

    expect(await readLastPushedSha('feat/a', dir)).toBe(tipSha);
    expect(await readLastPushedSha('feat/a-renamed', dir)).toBeNull();
  });

  it('skips push when --no-push is provided even if PR exists', async () => {
    await create('feat/a', dir);
    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/a');
    const branch = stack?.branches.find((b) => b.name === 'feat/a');
    if (branch) branch.pr_number = 7;
    const { writeState } = await import('../lib/state');
    await writeState(state, dir);

    const pushSpy = vi.spyOn(gitLib, 'pushBranch').mockResolvedValue(undefined);

    const result = await rename(dir, 'feat/a-renamed', undefined, {
      noPush: true,
    });

    expect(result.pushed).toBe(false);
    expect(result.prNumber).toBe(7);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
