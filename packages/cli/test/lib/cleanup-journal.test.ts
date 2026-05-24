import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendCleanupOperation,
  clearCleanupJournal,
  getCleanupJournalPath,
  hasCleanupJournal,
  readCleanupJournal,
  startCleanupJournal,
} from '../../src/lib/cleanup-journal';
import { createTestRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('cleanup journal', () => {
  it('records operations in order and clears on success', async () => {
    expect(await hasCleanupJournal(dir)).toBe(false);
    const journal = await startCleanupJournal(dir);
    expect(await hasCleanupJournal(dir)).toBe(true);

    await appendCleanupOperation(dir, journal, {
      type: 'reparent',
      branch: 'child',
      oldParent: 'middle',
      newParent: 'main',
    });
    await appendCleanupOperation(dir, journal, {
      type: 'delete',
      branch: 'middle',
      reason: 'merged-pr',
    });

    const reread = await readCleanupJournal(dir);
    expect(reread?.operations).toEqual([
      {
        type: 'reparent',
        branch: 'child',
        oldParent: 'middle',
        newParent: 'main',
      },
      { type: 'delete', branch: 'middle', reason: 'merged-pr' },
    ]);

    await clearCleanupJournal(dir);
    expect(await hasCleanupJournal(dir)).toBe(false);
  });

  it('rejects a malformed journal file', async () => {
    const journalPath = await getCleanupJournalPath(dir);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      '{"version": 99, "operations": []}\n',
      'utf8',
    );

    await expect(readCleanupJournal(dir)).rejects.toThrow(/malformed/);
  });

  it('clearCleanupJournal is a no-op when nothing is on disk', async () => {
    await expect(clearCleanupJournal(dir)).resolves.toBeUndefined();
  });

  it('refuses to start a new journal when one already exists', async () => {
    await startCleanupJournal(dir);
    await expect(startCleanupJournal(dir)).rejects.toThrow(
      /cleanup journal already exists/,
    );
    // The original journal file is left untouched so `dub continue` can replay.
    expect(await hasCleanupJournal(dir)).toBe(true);
  });
});
