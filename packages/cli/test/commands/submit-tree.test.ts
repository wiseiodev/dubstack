import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    const plan = await getSubmitPlan(dir, { stack: true });

    expect(plan.scope).toEqual({ kind: 'stack' });
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

    await expect(getSubmitPlan(dir, { stack: true })).resolves.toBeDefined();
  });

  it('default scope (downstack) limits to ancestors of current branch', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    await gitInRepo(dir, ['checkout', 'feat/bravo']);

    const plan = await getSubmitPlan(dir);
    expect(plan.scope).toEqual({ kind: 'downstack' });
    expect(plan.branches.map((b) => b.name)).toEqual(['feat/bravo']);
  });

  it('--upstack selects the current branch plus all descendants', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    await gitInRepo(dir, ['checkout', 'feat/alpha']);

    const plan = await getSubmitPlan(dir, { upstack: true });
    expect(plan.scope).toEqual({ kind: 'upstack' });
    expect(plan.branches.map((b) => b.name)).toEqual([
      'feat/alpha',
      'feat/alpha-grandchild',
    ]);
  });

  it('--downstack matches default behaviour', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    await gitInRepo(dir, ['checkout', 'feat/alpha-grandchild']);

    const plan = await getSubmitPlan(dir, { downstack: true });
    expect(plan.scope).toEqual({ kind: 'downstack' });
    expect(plan.branches.map((b) => b.name)).toEqual([
      'feat/alpha',
      'feat/alpha-grandchild',
    ]);
  });

  it('--branch <name> selects only the named branch', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    await gitInRepo(dir, ['checkout', 'feat/alpha-grandchild']);

    const plan = await getSubmitPlan(dir, { branch: 'feat/bravo' });
    expect(plan.scope).toEqual({ kind: 'branch', branch: 'feat/bravo' });
    expect(plan.branches.map((b) => b.name)).toEqual(['feat/bravo']);
  });

  it('--branch <name> rejects untracked branches', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();

    await expect(
      getSubmitPlan(dir, { branch: 'feat/nonexistent' }),
    ).rejects.toThrow('not part of any tracked stack');
  });

  it('rejects passing more than one scope flag', async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();

    await expect(
      getSubmitPlan(dir, { upstack: true, downstack: true }),
    ).rejects.toThrow('mutually exclusive');
  });

  it("'--path current' emits a deprecation warning and behaves like --downstack", async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    await gitInRepo(dir, ['checkout', 'feat/alpha-grandchild']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const plan = await getSubmitPlan(dir, { path: 'current' });
    expect(plan.scope).toEqual({ kind: 'downstack' });
    expect(plan.branches.map((b) => b.name)).toEqual([
      'feat/alpha',
      'feat/alpha-grandchild',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'--path current' is deprecated"),
    );
    warn.mockRestore();
  });

  it('--upstack throws an actionable error when stack metadata has a cycle', async () => {
    const cyclic: DubState = {
      stacks: [
        {
          id: 'cyclic-stack',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/a',
              parent: 'feat/b',
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
    };
    await writeState(cyclic, dir);
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    await expect(getSubmitPlan(dir, { upstack: true })).rejects.toThrow(
      /cycle detected while walking upstack/,
    );
  });

  it("'--path stack' emits a deprecation warning and behaves like --stack", async () => {
    await writeState(makeTreeState(), dir);
    await createTreeBranches();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const plan = await getSubmitPlan(dir, { path: 'stack' });
    expect(plan.scope).toEqual({ kind: 'stack' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'--path stack' is deprecated"),
    );
    warn.mockRestore();
  });
});
