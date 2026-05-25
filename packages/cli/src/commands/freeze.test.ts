import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { DubError } from '../lib/errors';
import { findStackForBranch, readState } from '../lib/state';
import { readUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { freeze } from './freeze';
import { init } from './init';
import { undo } from './undo';
import { unfreeze } from './unfreeze';

let dir: string;
let cleanup: () => Promise<void>;

async function frozenSet(): Promise<Set<string>> {
  const state = await readState(dir);
  const frozen = new Set<string>();
  for (const stack of state.stacks) {
    for (const branch of stack.branches) {
      if (branch.frozen === true) frozen.add(branch.name);
    }
  }
  return frozen;
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

describe('freeze', () => {
  it('marks the current branch as frozen by default', async () => {
    await create('feat/a', dir);

    const result = await freeze(dir);

    expect(result.changed).toEqual(['feat/a']);
    expect(result.unchanged).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(await frozenSet()).toEqual(new Set(['feat/a']));
  });

  it('freezes a specific tracked branch by name', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    const result = await freeze(dir, 'feat/a');

    expect(result.changed).toEqual(['feat/a']);
    expect(await frozenSet()).toEqual(new Set(['feat/a']));
  });

  it('cascades through descendants with --upstack', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await create('feat/c', dir);
    await gitInRepo(dir, ['checkout', 'feat/a']);

    const result = await freeze(dir, undefined, { upstack: true });

    expect(result.changed.sort()).toEqual(['feat/a', 'feat/b', 'feat/c']);
    expect(await frozenSet()).toEqual(new Set(['feat/a', 'feat/b', 'feat/c']));
  });

  it('cascades through ancestors with --downstack (excluding root)', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await create('feat/c', dir);

    const result = await freeze(dir, 'feat/c', { downstack: true });

    expect(result.changed.sort()).toEqual(['feat/a', 'feat/b', 'feat/c']);
    expect(await frozenSet()).toEqual(new Set(['feat/a', 'feat/b', 'feat/c']));
  });

  it('emits cascade results in topological (root → leaf) order', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await create('feat/c', dir);

    const downstackResult = await freeze(dir, 'feat/c', { downstack: true });
    expect(downstackResult.changed).toEqual(['feat/a', 'feat/b', 'feat/c']);

    await unfreeze(dir, 'feat/c', { downstack: true });
    await gitInRepo(dir, ['checkout', 'feat/a']);
    const upstackResult = await freeze(dir, undefined, { upstack: true });
    expect(upstackResult.changed).toEqual(['feat/a', 'feat/b', 'feat/c']);
  });

  it('refuses combining --upstack and --downstack', async () => {
    await create('feat/a', dir);
    await expect(
      freeze(dir, undefined, { upstack: true, downstack: true }),
    ).rejects.toBeInstanceOf(DubError);
  });

  it('refuses freezing the root branch', async () => {
    await expect(freeze(dir, 'main')).rejects.toBeInstanceOf(DubError);
  });

  it('refuses freezing an untracked branch', async () => {
    await expect(freeze(dir, 'feat/missing')).rejects.toBeInstanceOf(DubError);
  });

  it('reports unchanged when the branch is already frozen', async () => {
    await create('feat/a', dir);
    await freeze(dir);

    const result = await freeze(dir);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual(['feat/a']);
  });

  it('saves an undo entry that restores the previous frozen flags', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    await freeze(dir, 'feat/a', { upstack: true });
    const entry = await readUndoEntry(dir);
    expect(entry.operation).toBe('freeze');

    const result = await undo(dir);
    expect(result.undone).toBe('freeze');
    expect(await frozenSet()).toEqual(new Set());
  });

  it('undo of freeze does NOT switch checkout if the user has moved branches since freezing', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await gitInRepo(dir, ['checkout', 'feat/a']);

    // Freeze while on feat/a.
    await freeze(dir);

    // User switches to feat/b on their own. Undo must not yank them back.
    await gitInRepo(dir, ['checkout', 'feat/b']);

    await undo(dir);

    const after = (
      await gitInRepo(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ).stdout.trim();
    expect(after).toBe('feat/b');
    expect(await frozenSet()).toEqual(new Set());
  });

  it('skips a branch checked out in another worktree and does not mutate it', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    const worktreeDir = `${dir}-feat-a-worktree`;
    try {
      // feat/b is current. Move feat/a into a sibling worktree so that any
      // freeze targeting feat/a should be skipped without mutating state.
      await gitInRepo(dir, ['worktree', 'add', worktreeDir, 'feat/a']);

      const result = await freeze(dir, 'feat/a');

      expect(result.changed).toEqual([]);
      expect(result.unchanged).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.branch).toBe('feat/a');
      expect(result.skipped[0]?.worktree).toContain('feat-a-worktree');
      expect(await frozenSet()).toEqual(new Set());
    } finally {
      await gitInRepo(dir, [
        'worktree',
        'remove',
        '--force',
        worktreeDir,
      ]).catch(() => {});
      await fs.promises.rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it('cascade with --downstack freezes safe branches while skipping a worktree-checked-out ancestor', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await create('feat/c', dir);

    const worktreeDir = `${dir}-feat-b-worktree`;
    try {
      // feat/c is current. Park feat/b in another worktree so that a
      // --downstack cascade from feat/c freezes feat/a + feat/c but skips
      // feat/b. No undo entry is created for the skipped branch.
      await gitInRepo(dir, ['worktree', 'add', worktreeDir, 'feat/b']);

      const result = await freeze(dir, 'feat/c', { downstack: true });

      expect(result.changed.sort()).toEqual(['feat/a', 'feat/c']);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.branch).toBe('feat/b');
      expect(result.skipped[0]?.worktree).toContain('feat-b-worktree');
      expect(await frozenSet()).toEqual(new Set(['feat/a', 'feat/c']));
    } finally {
      await gitInRepo(dir, [
        'worktree',
        'remove',
        '--force',
        worktreeDir,
      ]).catch(() => {});
      await fs.promises.rm(worktreeDir, { recursive: true, force: true });
    }
  });
});

describe('unfreeze', () => {
  it('clears the frozen flag from a branch', async () => {
    await create('feat/a', dir);
    await freeze(dir);
    expect(await frozenSet()).toEqual(new Set(['feat/a']));

    const result = await unfreeze(dir);
    expect(result.changed).toEqual(['feat/a']);
    expect(await frozenSet()).toEqual(new Set());

    const state = await readState(dir);
    const branch = findStackForBranch(state, 'feat/a')?.branches.find(
      (b) => b.name === 'feat/a',
    );
    // delete-the-field keeps JSON compact for previously-untouched branches
    expect(branch).toBeDefined();
    expect(Object.hasOwn(branch ?? {}, 'frozen')).toBe(false);
  });

  it('cascades unfreeze through descendants with --upstack', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await create('feat/c', dir);
    await gitInRepo(dir, ['checkout', 'feat/a']);
    await freeze(dir, undefined, { upstack: true });

    const result = await unfreeze(dir, undefined, { upstack: true });
    expect(result.changed.sort()).toEqual(['feat/a', 'feat/b', 'feat/c']);
    expect(await frozenSet()).toEqual(new Set());
  });

  it('reports unchanged when the branch is already unfrozen', async () => {
    await create('feat/a', dir);

    const result = await unfreeze(dir);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual(['feat/a']);
  });

  it('saves an undo entry that restores the previous frozen flags', async () => {
    await create('feat/a', dir);
    await freeze(dir);

    await unfreeze(dir);
    const entry = await readUndoEntry(dir);
    expect(entry.operation).toBe('unfreeze');

    const result = await undo(dir);
    expect(result.undone).toBe('unfreeze');
    expect(await frozenSet()).toEqual(new Set(['feat/a']));
  });
});
