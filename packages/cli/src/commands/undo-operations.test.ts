import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { branchExists, getBranchTip } from '../lib/git';
import * as github from '../lib/github';
import { findStackForBranch, readState } from '../lib/state';
import { readUndoLog, saveUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { deleteCommand } from './delete';
import { init } from './init';
import { modify } from './modify';
import { track } from './track';
import { undo } from './undo';
import { untrack } from './untrack';

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

describe('undo: track', () => {
  it('restores pre-track state', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a']);

    await gitInRepo(dir, ['checkout', '-b', 'manual']);
    await track(dir, 'manual', { parent: 'feat/a', interactive: false });

    const before = await readState(dir);
    const stack = findStackForBranch(before, 'manual');
    expect(stack?.branches.find((b) => b.name === 'manual')).toBeDefined();

    await undo(dir);
    const after = await readState(dir);
    const afterStack = findStackForBranch(after, 'manual');
    expect(
      afterStack?.branches.find((b) => b.name === 'manual'),
    ).toBeUndefined();
  });
});

describe('undo: untrack', () => {
  it('restores pre-untrack state', async () => {
    await create('feat/a', dir);
    const stateBefore = await readState(dir);
    expect(
      stateBefore.stacks[0].branches.some((b) => b.name === 'feat/a'),
    ).toBe(true);

    await untrack(dir, 'feat/a', { interactive: false });
    const stateAfter = await readState(dir);
    expect(
      stateAfter.stacks[0]?.branches.some((b) => b.name === 'feat/a') ?? false,
    ).toBe(false);

    await undo(dir);
    const restored = await readState(dir);
    expect(restored.stacks[0].branches.some((b) => b.name === 'feat/a')).toBe(
      true,
    );
  });
});

describe('undo: delete', () => {
  it('restores stack metadata and surfaces recreation hint', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a']);
    await gitInRepo(dir, ['checkout', 'main']);

    await deleteCommand(dir, 'feat/a', { force: true, quiet: true });
    expect(await branchExists('feat/a', dir)).toBe(false);

    const result = await undo(dir);
    expect(result.undone).toBe('delete');

    const state = await readState(dir);
    expect(state.stacks[0].branches.some((b) => b.name === 'feat/a')).toBe(
      true,
    );

    // Git branch was not auto-recreated; warning surfaces the recreate hint.
    expect(await branchExists('feat/a', dir)).toBe(false);
    expect(result.warnings?.some((w) => w.includes('recreate'))).toBe(true);
  });
});

describe('undo: modify', () => {
  it('restores the branch tip to its pre-modify SHA', async () => {
    await create('feat/m', dir);
    fs.writeFileSync(path.join(dir, 'first.txt'), 'first');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'first']);
    const tipBeforeModify = await getBranchTip('feat/m', dir);

    fs.writeFileSync(path.join(dir, 'second.txt'), 'second');
    await gitInRepo(dir, ['add', '.']);
    await modify(dir, { commit: true, message: 'add second' });
    const tipAfterModify = await getBranchTip('feat/m', dir);
    expect(tipAfterModify).not.toBe(tipBeforeModify);

    // modify wires its own undo entry AND triggers a restack, which writes
    // its own entry. Undo unwinds the restack first, then the modify.
    await undo(dir, { steps: 2 });
    expect(await getBranchTip('feat/m', dir)).toBe(tipBeforeModify);
  });
});

describe('partial-success warning surface', () => {
  it('returns warnings as part of the UndoResult shape', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a']);
    await gitInRepo(dir, ['checkout', 'main']);

    await deleteCommand(dir, 'feat/a', { force: true, quiet: true });
    const result = await undo(dir);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('undo: submit', () => {
  it('restores previous PR bodies via gh and surfaces retarget warning', async () => {
    const updatePrBodySpy = vi
      .spyOn(github, 'updatePrBody')
      .mockResolvedValue();

    await saveUndoEntry(
      {
        operation: 'submit',
        timestamp: new Date().toISOString(),
        previousBranch: 'main',
        previousState: { stacks: [] },
        branchTips: {},
        createdBranches: [],
        prBodies: {
          '42': 'previous body for PR 42',
          '7': 'previous body for PR 7',
        },
      },
      dir,
    );

    const result = await undo(dir);
    expect(result.undone).toBe('submit');
    expect(updatePrBodySpy).toHaveBeenCalledTimes(2);
    expect(result.warnings?.some((w) => w.includes('retarget'))).toBe(true);

    updatePrBodySpy.mockRestore();
  });

  it('surfaces partial-success warning when PR body update fails', async () => {
    const updatePrBodySpy = vi
      .spyOn(github, 'updatePrBody')
      .mockRejectedValueOnce(new Error('403 forbidden'))
      .mockResolvedValueOnce();

    await saveUndoEntry(
      {
        operation: 'submit',
        timestamp: new Date().toISOString(),
        previousBranch: 'main',
        previousState: { stacks: [] },
        branchTips: {},
        createdBranches: [],
        prBodies: {
          '99': 'body for 99',
          '100': 'body for 100',
        },
      },
      dir,
    );

    const result = await undo(dir);
    expect(result.warnings?.some((w) => w.includes('#99'))).toBe(true);
    updatePrBodySpy.mockRestore();
  });
});

describe('ring buffer rollover', () => {
  it('keeps only the most recent 20 entries', async () => {
    for (let i = 0; i < 25; i++) {
      await create(`feat/r-${i}`, dir);
      await gitInRepo(dir, ['checkout', 'main']);
    }
    const entries = await readUndoLog(dir);
    expect(entries.length).toBe(20);
    expect(entries[entries.length - 1].createdBranches).toEqual(['feat/r-24']);
    expect(entries[0].createdBranches).toEqual(['feat/r-5']);
  });
});
