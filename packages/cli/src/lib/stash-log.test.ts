import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { init } from '../commands/init';
import {
  prependStashLogEntry,
  readStashLog,
  removeStashLogEntry,
  STASH_LOG_LIMIT,
  type StashLogEntry,
  writeStashLog,
} from './stash-log';
import { getDubDir } from './state';

let dir: string;
let cleanup: () => Promise<void>;

function makeEntry(i: number): StashLogEntry {
  return {
    sha: i.toString(16).padStart(40, '0'),
    branch: `feat/${i}`,
    message: `stash ${i}`,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  };
}

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
});

afterEach(async () => {
  await cleanup();
});

describe('stash-log', () => {
  it('returns an empty list when no log file exists', async () => {
    expect(await readStashLog(dir)).toEqual([]);
  });

  it('prepends new entries so most-recent is first', async () => {
    await prependStashLogEntry(makeEntry(1), dir);
    await prependStashLogEntry(makeEntry(2), dir);
    const log = await readStashLog(dir);
    expect(log.map((e) => e.sha)).toEqual([makeEntry(2).sha, makeEntry(1).sha]);
  });

  it('trims to the ring-buffer limit on write', async () => {
    const entries = Array.from({ length: STASH_LOG_LIMIT + 10 }, (_, i) =>
      makeEntry(i),
    );
    await writeStashLog(entries, dir);
    const log = await readStashLog(dir);
    expect(log).toHaveLength(STASH_LOG_LIMIT);
    expect(log[0].sha).toBe(entries[0].sha);
    expect(log[STASH_LOG_LIMIT - 1].sha).toBe(entries[STASH_LOG_LIMIT - 1].sha);
  });

  it('removes an entry by sha', async () => {
    await writeStashLog([makeEntry(1), makeEntry(2), makeEntry(3)], dir);
    await removeStashLogEntry(makeEntry(2).sha, dir);
    const log = await readStashLog(dir);
    expect(log.map((e) => e.sha)).toEqual([makeEntry(1).sha, makeEntry(3).sha]);
  });

  it('treats a corrupt file as empty rather than throwing', async () => {
    const dubDir = await getDubDir(dir);
    fs.writeFileSync(path.join(dubDir, 'stash-log.json'), '{not json');
    expect(await readStashLog(dir)).toEqual([]);
  });
});
