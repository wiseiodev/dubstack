import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { DubError } from './errors';
import { getDubDir, initState } from './state';
import {
  clearUndoEntry,
  clearUndoLog,
  MAX_UNDO_ENTRIES,
  popRedoEntry,
  popUndoEntry,
  pushRedoEntry,
  pushUndoEntryPreserveRedo,
  readRedoLog,
  readUndoEntry,
  readUndoLog,
  saveUndoEntry,
  type UndoEntry,
} from './undo-log';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await initState(dir);
});

afterEach(async () => {
  await cleanup();
});

function makeEntry(overrides?: Partial<UndoEntry>): UndoEntry {
  return {
    operation: 'create',
    timestamp: new Date().toISOString(),
    previousBranch: 'main',
    previousState: { stacks: [] },
    branchTips: {},
    createdBranches: [],
    ...overrides,
  };
}

describe('saveUndoEntry and readUndoEntry', () => {
  it('roundtrips correctly', async () => {
    const entry = makeEntry({
      operation: 'create',
      createdBranches: ['feat/a'],
    });
    await saveUndoEntry(entry, dir);
    const loaded = await readUndoEntry(dir);
    expect(loaded).toEqual(entry);
  });
});

describe('readUndoEntry', () => {
  it('throws when no entry exists', async () => {
    await expect(readUndoEntry(dir)).rejects.toThrow(DubError);
    await expect(readUndoEntry(dir)).rejects.toThrow('Nothing to undo');
  });
});

describe('clearUndoEntry', () => {
  it('removes only the most recent entry', async () => {
    await saveUndoEntry(makeEntry({ operation: 'create' }), dir);
    await saveUndoEntry(makeEntry({ operation: 'restack' }), dir);
    await clearUndoEntry(dir);
    const remaining = await readUndoLog(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].operation).toBe('create');
  });

  it('is a no-op when the ring is empty', async () => {
    await expect(clearUndoEntry(dir)).resolves.toBeUndefined();
  });
});

describe('ring buffer behavior', () => {
  it('returns the most recent entry from readUndoEntry', async () => {
    const first = makeEntry({
      operation: 'create',
      createdBranches: ['feat/a'],
    });
    const second = makeEntry({ operation: 'restack', createdBranches: [] });

    await saveUndoEntry(first, dir);
    await saveUndoEntry(second, dir);

    const loaded = await readUndoEntry(dir);
    expect(loaded.operation).toBe('restack');
  });

  it('keeps the last MAX_UNDO_ENTRIES entries', async () => {
    for (let i = 0; i < MAX_UNDO_ENTRIES + 5; i++) {
      await saveUndoEntry(
        makeEntry({ operation: 'modify', previousBranch: `b-${i}` }),
        dir,
      );
    }
    const entries = await readUndoLog(dir);
    expect(entries).toHaveLength(MAX_UNDO_ENTRIES);
    // Oldest 5 dropped; newest at the end.
    expect(entries[0].previousBranch).toBe('b-5');
    expect(entries[entries.length - 1].previousBranch).toBe(
      `b-${MAX_UNDO_ENTRIES + 4}`,
    );
  });

  it('popUndoEntry returns and removes the most recent entry', async () => {
    await saveUndoEntry(makeEntry({ previousBranch: 'a' }), dir);
    await saveUndoEntry(makeEntry({ previousBranch: 'b' }), dir);
    const popped = await popUndoEntry(dir);
    expect(popped.previousBranch).toBe('b');
    const remaining = await readUndoLog(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].previousBranch).toBe('a');
  });

  it('popUndoEntry throws when empty', async () => {
    await expect(popUndoEntry(dir)).rejects.toThrow('Nothing to undo');
  });
});

describe('legacy undo.json migration', () => {
  it('migrates a single-entry undo.json into the ring on first read', async () => {
    const dubDir = await getDubDir(dir);
    const legacyPath = path.join(dubDir, 'undo.json');
    const entry = makeEntry({
      operation: 'create',
      createdBranches: ['legacy/branch'],
    });
    fs.writeFileSync(legacyPath, `${JSON.stringify(entry, null, 2)}\n`);

    const loaded = await readUndoEntry(dir);
    expect(loaded.operation).toBe('create');
    expect(loaded.createdBranches).toEqual(['legacy/branch']);
    // Legacy file removed after migration.
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(path.join(dubDir, 'undo-log.json'))).toBe(true);
  });

  it('prefers the new log when both files exist', async () => {
    const dubDir = await getDubDir(dir);
    const legacyPath = path.join(dubDir, 'undo.json');
    await saveUndoEntry(
      makeEntry({ operation: 'restack', previousBranch: 'newer' }),
      dir,
    );
    fs.writeFileSync(
      legacyPath,
      `${JSON.stringify(makeEntry({ operation: 'create', previousBranch: 'older' }), null, 2)}\n`,
    );

    const loaded = await readUndoEntry(dir);
    expect(loaded.operation).toBe('restack');
    expect(loaded.previousBranch).toBe('newer');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});

describe('redo ring', () => {
  it('save → push redo → undo clears redo path on new save', async () => {
    await saveUndoEntry(makeEntry({ previousBranch: 'a' }), dir);
    await pushRedoEntry(makeEntry({ previousBranch: 'a-redo' }), dir);
    expect(await readRedoLog(dir)).toHaveLength(1);
    await saveUndoEntry(makeEntry({ previousBranch: 'b' }), dir);
    expect(await readRedoLog(dir)).toHaveLength(0);
  });

  it('popRedoEntry returns and removes the most recent entry', async () => {
    await pushRedoEntry(makeEntry({ previousBranch: 'r1' }), dir);
    await pushRedoEntry(makeEntry({ previousBranch: 'r2' }), dir);
    const popped = await popRedoEntry(dir);
    expect(popped?.previousBranch).toBe('r2');
    const remaining = await readRedoLog(dir);
    expect(remaining).toHaveLength(1);
  });

  it('popRedoEntry returns null when empty', async () => {
    expect(await popRedoEntry(dir)).toBeNull();
  });

  it('redo ring is capped at MAX_UNDO_ENTRIES', async () => {
    for (let i = 0; i < MAX_UNDO_ENTRIES + 3; i++) {
      await pushRedoEntry(makeEntry({ previousBranch: `r-${i}` }), dir);
    }
    const entries = await readRedoLog(dir);
    expect(entries).toHaveLength(MAX_UNDO_ENTRIES);
    expect(entries[0].previousBranch).toBe('r-3');
  });

  it('pushUndoEntryPreserveRedo does not clear the redo stack', async () => {
    await pushRedoEntry(makeEntry({ previousBranch: 'keep-me' }), dir);
    await pushUndoEntryPreserveRedo(makeEntry({ previousBranch: 'new' }), dir);
    expect(await readRedoLog(dir)).toHaveLength(1);
    expect((await readUndoLog(dir))[0].previousBranch).toBe('new');
  });
});

describe('clearUndoLog', () => {
  it('removes both undo and redo logs', async () => {
    await saveUndoEntry(makeEntry({ previousBranch: 'a' }), dir);
    await pushRedoEntry(makeEntry({ previousBranch: 'b' }), dir);
    await clearUndoLog(dir);
    expect(await readUndoLog(dir)).toHaveLength(0);
    expect(await readRedoLog(dir)).toHaveLength(0);
  });
});
