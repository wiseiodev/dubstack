import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import {
  appendCheckoutHistory,
  readCheckoutHistory,
} from '../lib/checkout-history';
import { getCurrentBranch } from '../lib/git';
import { back, listBackHistory } from './back';
import { init } from './init';

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

describe('back', () => {
  it('throws with a hint when checkout history is empty', async () => {
    await expect(back(dir)).rejects.toMatchObject({
      message: 'No checkout history available.',
      recovery: expect.arrayContaining([
        "Run 'dub co <branch>' or another DubStack navigation command first.",
      ]),
    });
  });

  it('lists checkout history newest first without switching branches', async () => {
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/a', { via: 'create' });

    const entries = await listBackHistory(dir);

    expect(entries.map((entry) => entry.branch)).toEqual(['feat/a', 'main']);
    expect(await getCurrentBranch(dir)).toBe('main');
  });

  it('goes back N available branches and consumes history without appending', async () => {
    await createBranch('feat/a');
    await createBranch('feat/b');
    await createBranch('feat/c');
    await gitInRepo(dir, ['checkout', 'feat/c']);
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/a', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/b', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/c', { via: 'checkout' });

    const result = await back(dir, 2);

    expect(result.branch).toBe('feat/a');
    expect(result.popped.map((entry) => entry.branch)).toEqual([
      'feat/b',
      'feat/a',
    ]);
    expect(await getCurrentBranch(dir)).toBe('feat/a');
    expect(
      (await readCheckoutHistory(dir)).map((entry) => entry.branch),
    ).toEqual(['main']);
  });

  it('skips deleted branches with a warning payload', async () => {
    await createBranch('feat/a');
    await createBranch('feat/deleted');
    await createBranch('feat/current');
    await gitInRepo(dir, ['checkout', 'feat/current']);
    await gitInRepo(dir, ['branch', '-D', 'feat/deleted']);
    await appendCheckoutHistory(dir, 'main', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/a', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/deleted', { via: 'checkout' });
    await appendCheckoutHistory(dir, 'feat/current', { via: 'checkout' });

    const result = await back(dir);

    expect(result.branch).toBe('feat/a');
    expect(result.skipped.map((entry) => entry.branch)).toEqual([
      'feat/deleted',
    ]);
    expect(await getCurrentBranch(dir)).toBe('feat/a');
    expect(
      (await readCheckoutHistory(dir)).map((entry) => entry.branch),
    ).toEqual(['main']);
  });
});

async function createBranch(name: string): Promise<void> {
  await gitInRepo(dir, ['checkout', 'main']);
  await gitInRepo(dir, ['checkout', '-b', name]);
  await gitInRepo(dir, ['commit', '--allow-empty', '-m', `create ${name}`]);
}
