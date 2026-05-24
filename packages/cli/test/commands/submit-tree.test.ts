import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSubmitPlan } from '../../src/commands/submit';
import type { DubState } from '../../src/lib/state';
import { writeState } from '../../src/lib/state';
import { createTestRepo, gitInRepo } from '../helpers';

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

function makeTreeState(): DubState {
  return {
    stacks: [
      {
        id: 'tree-stack',
        branches: [
          {
            name: 'main',
            parent: null,
            type: 'root',
            pr_number: null,
            pr_link: null,
          },
          {
            name: 'feat/charlie',
            parent: 'main',
            pr_number: null,
            pr_link: null,
          },
          {
            name: 'feat/alpha',
            parent: 'main',
            pr_number: null,
            pr_link: null,
          },
          {
            name: 'feat/bravo',
            parent: 'main',
            pr_number: null,
            pr_link: null,
          },
        ],
      },
    ],
  };
}

describe('submit tree integration', () => {
  it('plans submit for a 3-sibling tree with parent first and siblings sorted by name', async () => {
    await writeState(makeTreeState(), dir);
    await gitInRepo(dir, ['checkout', '-b', 'feat/alpha']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/bravo', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/charlie', 'main']);

    const plan = await getSubmitPlan(dir, { path: 'stack' });

    expect(plan.path).toBe('stack');
    expect(plan.rootBranch).toBe('main');
    expect(plan.branches.map((b) => b.name)).toEqual([
      'feat/alpha',
      'feat/bravo',
      'feat/charlie',
    ]);
    for (const branch of plan.branches) {
      expect(branch.parent).toBe('main');
    }
  });

  it('does not throw the legacy branching-blocker error on a tree stack', async () => {
    await writeState(makeTreeState(), dir);
    await gitInRepo(dir, ['checkout', '-b', 'feat/alpha']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/bravo', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/charlie', 'main']);

    await expect(getSubmitPlan(dir, { path: 'stack' })).resolves.toBeDefined();
  });

  it('limits --path current to the linear path even when siblings exist', async () => {
    await writeState(makeTreeState(), dir);
    await gitInRepo(dir, ['checkout', '-b', 'feat/alpha']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/bravo', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/charlie', 'main']);
    await gitInRepo(dir, ['checkout', 'feat/bravo']);

    const plan = await getSubmitPlan(dir, { path: 'current' });
    expect(plan.path).toBe('current');
    expect(plan.branches.map((b) => b.name)).toEqual(['feat/bravo']);
  });
});
