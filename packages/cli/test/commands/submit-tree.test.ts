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
            name: 'feat/alpha-grandchild',
            parent: 'feat/alpha',
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

async function createTreeBranches(): Promise<void> {
  await gitInRepo(dir, ['checkout', '-b', 'feat/alpha']);
  await gitInRepo(dir, ['checkout', '-b', 'feat/alpha-grandchild']);
  await gitInRepo(dir, ['checkout', '-b', 'feat/bravo', 'main']);
  await gitInRepo(dir, ['checkout', '-b', 'feat/charlie', 'main']);
}

describe('submit tree integration', () => {
  it('walks the tree in BFS order: every parent emitted before any grandchild, siblings sorted by name', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();

    const plan = await getSubmitPlan(dir, { path: 'stack' });

    expect(plan.path).toBe('stack');
    expect(plan.rootBranch).toBe('main');
    // BFS-correct: feat/alpha comes before its child feat/alpha-grandchild,
    // and all main-children come before any grandchild. Siblings under main
    // are alphabetical.
    expect(plan.branches.map((b) => b.name)).toEqual([
      'feat/alpha',
      'feat/bravo',
      'feat/charlie',
      'feat/alpha-grandchild',
    ]);
    expect(
      plan.branches.find((b) => b.name === 'feat/alpha-grandchild')?.parent,
    ).toBe('feat/alpha');
  });

  it('does not throw the legacy branching-blocker error on a tree stack', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();

    await expect(getSubmitPlan(dir, { path: 'stack' })).resolves.toBeDefined();
  });

  it('limits --path current to the linear path even when siblings exist', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    await gitInRepo(dir, ['checkout', 'feat/bravo']);

    const plan = await getSubmitPlan(dir, { path: 'current' });
    expect(plan.path).toBe('current');
    expect(plan.branches.map((b) => b.name)).toEqual(['feat/bravo']);
  });
});
