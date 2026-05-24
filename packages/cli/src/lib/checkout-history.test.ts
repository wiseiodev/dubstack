import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import {
  appendCheckoutHistory,
  clearCheckoutHistory,
  getCheckoutHistoryPath,
  readCheckoutHistory,
} from './checkout-history';

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

describe('checkout-history', () => {
  it('appends entries and reads them newest-first', async () => {
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feature/a', { via: 'create' });
    await appendCheckoutHistory(dir, 'feature/b', { via: 'up' });

    const entries = await readCheckoutHistory(dir);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.branch)).toEqual([
      'feature/b',
      'feature/a',
      'main',
    ]);
    expect(entries[0].via).toBe('up');
    expect(entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty array when no history file exists', async () => {
    const entries = await readCheckoutHistory(dir);
    expect(entries).toEqual([]);
  });

  it('filters transient entries from default reads', async () => {
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feature/a', {
      via: 'sync',
      transient: true,
    });
    await appendCheckoutHistory(dir, 'feature/b', { via: 'down' });

    const entries = await readCheckoutHistory(dir);
    expect(entries.map((e) => e.branch)).toEqual(['feature/b', 'main']);
  });

  it('enforces a ring buffer of size 20', async () => {
    for (let i = 0; i < 25; i++) {
      await appendCheckoutHistory(dir, `branch-${i}`, { via: 'checkout' });
    }

    const entries = await readCheckoutHistory(dir, 100);
    expect(entries).toHaveLength(20);
    expect(entries[0].branch).toBe('branch-24');
    expect(entries[19].branch).toBe('branch-5');
  });

  it('respects a custom limit on read', async () => {
    for (let i = 0; i < 5; i++) {
      await appendCheckoutHistory(dir, `branch-${i}`, { via: 'checkout' });
    }

    const entries = await readCheckoutHistory(dir, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].branch).toBe('branch-4');
    expect(entries[1].branch).toBe('branch-3');
  });

  it('returns empty array when limit is zero or negative', async () => {
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    expect(await readCheckoutHistory(dir, 0)).toEqual([]);
    expect(await readCheckoutHistory(dir, -1)).toEqual([]);
  });

  it('clears the history file', async () => {
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    await clearCheckoutHistory(dir);
    expect(await readCheckoutHistory(dir)).toEqual([]);

    const target = await getCheckoutHistoryPath(dir);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('treats corrupt JSON as empty history', async () => {
    const target = await getCheckoutHistoryPath(dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not json');

    expect(await readCheckoutHistory(dir)).toEqual([]);

    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    const entries = await readCheckoutHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe('main');
  });

  it('writes atomically and leaves no temp files behind', async () => {
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });

    const target = await getCheckoutHistoryPath(dir);
    const dirContents = fs.readdirSync(path.dirname(target));
    const tempFiles = dirContents.filter((name) =>
      name.startsWith('checkout-history.json.'),
    );
    expect(tempFiles).toEqual([]);
  });

  it('only treats strict boolean true as transient — corrupt values are visible', async () => {
    const target = await getCheckoutHistoryPath(dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify([
        { branch: 'main', at: '2026-05-24T00:00:00Z', via: 'checkout' },
        {
          branch: 'string-true',
          at: '2026-05-24T00:00:01Z',
          via: 'sync',
          transient: 'true',
        },
        {
          branch: 'numeric-one',
          at: '2026-05-24T00:00:02Z',
          via: 'sync',
          transient: 1,
        },
        {
          branch: 'real-transient',
          at: '2026-05-24T00:00:03Z',
          via: 'sync',
          transient: true,
        },
      ]),
    );

    const entries = await readCheckoutHistory(dir);
    // 'real-transient' is the only one filtered; the malformed ones are
    // normalized to non-transient and remain visible (newest-first).
    expect(entries.map((e) => e.branch)).toEqual([
      'numeric-one',
      'string-true',
      'main',
    ]);
  });

  it('keeps transient entries in storage for limit accounting', async () => {
    for (let i = 0; i < 20; i++) {
      await appendCheckoutHistory(dir, `transient-${i}`, {
        via: 'sync',
        transient: true,
      });
    }
    await appendCheckoutHistory(dir, 'visible', { via: 'checkout' });

    const entries = await readCheckoutHistory(dir);
    expect(entries.map((e) => e.branch)).toEqual(['visible']);
  });
});
