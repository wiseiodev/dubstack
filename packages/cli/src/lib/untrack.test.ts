import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { initState, readState, writeState } from './state';
import { untrackBranch } from './untrack';

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

async function seedState() {
  await writeState(
    {
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    },
    dir,
  );
}

describe('untrackBranch', () => {
  it('untracks a leaf branch', async () => {
    await seedState();

    const result = await untrackBranch(dir, { branch: 'feat/b' });

    expect(result.removed).toEqual(['feat/b']);
    const state = await readState(dir);
    expect(
      state.stacks[0].branches.some((branch) => branch.name === 'feat/b'),
    ).toBe(false);
  });

  it('untracks branch and descendants with --downstack', async () => {
    await seedState();

    const result = await untrackBranch(dir, {
      branch: 'feat/a',
      downstack: true,
    });

    expect(result.removed).toEqual(['feat/a', 'feat/b']);
    const state = await readState(dir);
    expect(state.stacks[0].branches.map((branch) => branch.name)).toEqual([
      'main',
    ]);
  });
});
