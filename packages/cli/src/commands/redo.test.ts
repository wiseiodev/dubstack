import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { DubError } from '../lib/errors';
import { branchExists, getBranchTip, getCurrentBranch } from '../lib/git';
import { readState } from '../lib/state';
import { readRedoLog, readUndoLog } from '../lib/undo-log';
import { create } from './create';
import { init } from './init';
import { redo } from './redo';
import { restack } from './restack';
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
  await cleanup();
});

describe('redo', () => {
  it('throws when nothing to redo', async () => {
    await expect(redo(dir)).rejects.toThrow(DubError);
    await expect(redo(dir)).rejects.toThrow('Nothing to redo');
  });

  it('redoes a create by recreating the branch and restoring state', async () => {
    await create('feat/redo', dir);
    expect(await branchExists('feat/redo', dir)).toBe(true);

    await undo(dir);
    expect(await branchExists('feat/redo', dir)).toBe(false);

    const result = await redo(dir);
    expect(result.redone).toBe('create');
    expect(await branchExists('feat/redo', dir)).toBe(true);
    expect(await getCurrentBranch(dir)).toBe('feat/redo');

    const state = await readState(dir);
    expect(state.stacks).toHaveLength(1);
  });

  it('redoes a restack by restoring post-restack branch tips', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base']);
    await gitInRepo(dir, ['checkout', 'feat/a']);

    await restack(dir);
    const postRestackTip = await getBranchTip('feat/a', dir);

    await undo(dir);
    expect(await getBranchTip('feat/a', dir)).not.toBe(postRestackTip);

    await redo(dir);
    expect(await getBranchTip('feat/a', dir)).toBe(postRestackTip);
  });

  it('supports multiple undo→redo cycles', async () => {
    await create('feat/a', dir);
    await undo(dir);
    await redo(dir);
    await undo(dir);
    await redo(dir);
    expect(await branchExists('feat/a', dir)).toBe(true);
  });

  it('clears the redo stack on new mutation', async () => {
    await create('feat/a', dir);
    await undo(dir);
    expect((await readRedoLog(dir)).length).toBeGreaterThan(0);

    await create('feat/b', dir);
    expect((await readRedoLog(dir)).length).toBe(0);

    await expect(redo(dir)).rejects.toThrow('Nothing to redo');
  });

  it('after redo, the entry is undoable again (preserves redo for subsequent undo)', async () => {
    await create('feat/a', dir);
    await undo(dir);
    await redo(dir);

    expect(await branchExists('feat/a', dir)).toBe(true);
    // Undo again should remove it.
    await undo(dir);
    expect(await branchExists('feat/a', dir)).toBe(false);
  });
});

describe('undo --steps N', () => {
  it('undoes multiple operations in sequence', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await create('feat/c', dir);

    const result = await undo(dir, { steps: 3 });
    expect(result.details).toContain('Undid 3 operation(s)');
    expect(await branchExists('feat/a', dir)).toBe(false);
    expect(await branchExists('feat/b', dir)).toBe(false);
    expect(await branchExists('feat/c', dir)).toBe(false);
  });

  it('stops gracefully when fewer entries than steps requested', async () => {
    await create('feat/only', dir);
    const result = await undo(dir, { steps: 5 });
    expect(result.details).toContain('Undid 1 operation');
  });

  it('rejects non-positive steps', async () => {
    await create('feat/a', dir);
    await expect(undo(dir, { steps: 0 })).rejects.toThrow(
      "'--steps' must be a positive integer",
    );
  });
});

describe('undo --clear and --list', () => {
  it('listUndo returns entries oldest-first', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    const { listUndo } = await import('./undo');
    const entries = await listUndo(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].operation).toBe('create');
    expect(entries[0].createdBranches).toEqual(['feat/a']);
    expect(entries[1].operation).toBe('create');
    expect(entries[1].createdBranches).toEqual(['feat/b']);
  });

  it('clearUndo wipes both undo and redo rings', async () => {
    await create('feat/a', dir);
    await undo(dir);
    expect((await readRedoLog(dir)).length).toBeGreaterThan(0);

    const { clearUndo } = await import('./undo');
    await clearUndo(dir);
    expect(await readUndoLog(dir)).toHaveLength(0);
    expect(await readRedoLog(dir)).toHaveLength(0);
  });
});

describe('multi-level undo across mixed operations', () => {
  it('undoes track then create independently', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a']);

    // Switch off and track an existing branch manually
    await gitInRepo(dir, ['checkout', '-b', 'manual']);
    const { track } = await import('./track');
    await track(dir, 'manual', { parent: 'feat/a', interactive: false });

    const entries = await readUndoLog(dir);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Top of undo = track
    await undo(dir);
    let state = await readState(dir);
    // After undoing track, 'manual' should no longer be tracked.
    const stack = state.stacks[0];
    expect(stack.branches.find((b) => b.name === 'manual')).toBeUndefined();

    // Next undo = create
    await undo(dir);
    state = await readState(dir);
    expect(state.stacks).toHaveLength(0);
  });
});
