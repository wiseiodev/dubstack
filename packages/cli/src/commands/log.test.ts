import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import type { BranchOverview, StackOverview } from '../lib/stack-overview';
import { type DubState, initState, type Stack, writeState } from '../lib/state';
import { computeRegions, log, logJson, styleLogOutput } from './log';

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

describe('log', () => {
  it('renders a linear chain with current branch highlighted', async () => {
    // Create branches in git so branchExists returns true
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const state: DubState = {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
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
    await writeState(state, dir);

    // Currently on feat/b
    const output = await log(dir);
    expect(output).toBe('(main)\n  └─ >feat/a\n       └─ *feat/b (Current)*');
  });

  it('returns a JSON tree with the same branch metadata', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);

    const state: DubState = {
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
              pr_number: 7,
              pr_link: 'https://github.com/example/repo/pull/7',
            },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const output = await logJson(dir);
    expect(output).toMatchObject({
      currentBranch: 'feat/a',
      stacks: [
        {
          id: 'stack-1',
          root: {
            name: 'main',
            type: 'root',
            current: false,
            children: [
              {
                name: 'feat/a',
                type: 'branch',
                parent: 'main',
                current: true,
                exists: true,
                prNumber: 7,
              },
            ],
          },
        },
      ],
    });
  });

  it('renders branching with correct connectors', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const state: DubState = {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
            { name: 'feat/b', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    await writeState(state, dir);

    // Currently on feat/b — feat/a is a sibling-subtree branch
    const output = await log(dir);
    expect(output).toContain('├─ ~feat/a~');
    expect(output).toContain('└─ *feat/b (Current)*');
  });

  it('returns message for empty state', async () => {
    const output = await log(dir);
    expect(output).toBe("No stacks. Run 'dub create' to start.");
  });

  it('renders multiple stacks separated by blank line', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const state: DubState = {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
        {
          id: 'stack-2',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            { name: 'feat/b', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const output = await log(dir);
    expect(output).toContain('\n\n');
  });

  it('marks frozen branches with 🔒 in rendered output and JSON', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const state: DubState = {
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
              frozen: true,
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
    await writeState(state, dir);

    const output = await log(dir);
    expect(output).toContain('>feat/a 🔒');
    expect(output).not.toContain('feat/b 🔒');

    const json = await logJson(dir);
    const frozenBranch = json.stacks[0]?.root?.children[0];
    expect(frozenBranch?.name).toBe('feat/a');
    expect(frozenBranch?.frozen).toBe(true);
    expect(frozenBranch?.children[0]?.frozen).toBe(false);
  });

  it('marks branches that are missing from git', async () => {
    const state: DubState = {
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
              name: 'feat/deleted',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const output = await log(dir);
    expect(output).toContain('feat/deleted ⚠ (missing)');
  });

  it('supports --stack mode to show only current stack', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const state: DubState = {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
        {
          id: 'stack-2',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            { name: 'feat/b', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    await writeState(state, dir);
    await gitInRepo(dir, ['checkout', 'feat/b']);

    const output = await log(dir, { stack: true });
    expect(output).toContain('feat/b');
    expect(output).not.toContain('feat/a');
  });

  it('supports --all mode to show all stacks', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const state: DubState = {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
        {
          id: 'stack-2',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            { name: 'feat/b', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const output = await log(dir, { all: true });
    expect(output).toContain('feat/a');
    expect(output).toContain('feat/b');
  });

  it('supports --reverse mode for child ordering', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/c']);

    const state: DubState = {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
            { name: 'feat/b', parent: 'main', pr_number: null, pr_link: null },
            { name: 'feat/c', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const output = await log(dir, { reverse: true });
    expect(output.indexOf('feat/c')).toBeLessThan(output.indexOf('feat/a'));
  });

  describe('region markers', () => {
    async function buildTree(d: string) {
      await gitInRepo(d, ['checkout', '-b', 'feat/auth-base']);
      await gitInRepo(d, ['checkout', '-b', 'feat/auth-login']);
      await gitInRepo(d, ['checkout', 'feat/auth-base']);
      await gitInRepo(d, ['checkout', '-b', 'feat/auth-sibling']);
      await gitInRepo(d, ['checkout', '-b', 'feat/auth-grandchild']);
      await gitInRepo(d, ['checkout', '-b', 'feat/auth-tip']);
      const state: DubState = {
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
                name: 'feat/auth-base',
                parent: 'main',
                pr_number: null,
                pr_link: null,
              },
              {
                name: 'feat/auth-login',
                parent: 'feat/auth-base',
                pr_number: null,
                pr_link: null,
              },
              {
                name: 'feat/auth-sibling',
                parent: 'feat/auth-base',
                pr_number: null,
                pr_link: null,
              },
              {
                name: 'feat/auth-grandchild',
                parent: 'feat/auth-sibling',
                pr_number: null,
                pr_link: null,
              },
              {
                name: 'feat/auth-tip',
                parent: 'feat/auth-grandchild',
                pr_number: null,
                pr_link: null,
              },
            ],
          },
        ],
      };
      await writeState(state, d);
    }

    it('marks ancestor path with > on the current branch chain', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'feat/auth-login']);

      const output = await log(dir);
      expect(output).toContain('>feat/auth-base');
      expect(output).toContain('*feat/auth-login (Current)*');
    });

    it('wraps sibling sub-tree branches in ~ markers', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'feat/auth-login']);

      const output = await log(dir);
      expect(output).toContain('~feat/auth-sibling~');
      expect(output).toContain('~feat/auth-grandchild~');
      expect(output).toContain('~feat/auth-tip~');
    });

    it('leaves descendants of the current branch unmarked', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'feat/auth-base']);

      const output = await log(dir);
      expect(output).toContain('├─ feat/auth-login');
      expect(output).not.toContain('>feat/auth-login');
      expect(output).not.toContain('~feat/auth-login~');
    });

    it('exposes the region per branch in logJson', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'feat/auth-login']);

      const output = await logJson(dir);
      const stackRoot = output.stacks[0]?.root;
      expect(stackRoot?.region).toBe('root');

      const base = stackRoot?.children[0];
      expect(base?.name).toBe('feat/auth-base');
      expect(base?.region).toBe('ancestor');

      const baseChildren = base?.children ?? [];
      const login = baseChildren.find((b) => b.name === 'feat/auth-login');
      const sibling = baseChildren.find((b) => b.name === 'feat/auth-sibling');
      const grandchild = sibling?.children[0];
      const tip = grandchild?.children[0];

      expect(login?.region).toBe('current');
      expect(sibling?.region).toBe('sibling-subtree');
      expect(grandchild?.region).toBe('sibling-subtree');
      expect(tip?.region).toBe('sibling-subtree');
    });

    it('keeps the ancestor marker for ancestors that are missing from git', async () => {
      await gitInRepo(dir, ['checkout', '-b', 'feat/auth-base']);
      await gitInRepo(dir, ['checkout', '-b', 'feat/auth-login']);
      await gitInRepo(dir, ['branch', '-D', 'feat/auth-base']);
      const state: DubState = {
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
                name: 'feat/auth-base',
                parent: 'main',
                pr_number: null,
                pr_link: null,
              },
              {
                name: 'feat/auth-login',
                parent: 'feat/auth-base',
                pr_number: null,
                pr_link: null,
              },
            ],
          },
        ],
      };
      await writeState(state, dir);

      const output = await log(dir);
      expect(output).toContain('>feat/auth-base ⚠ (missing)');
      expect(output).toContain('*feat/auth-login (Current)*');
    });

    it('reports every non-root branch as descendant when current is not in stack', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'main']);
      await gitInRepo(dir, ['checkout', '-b', 'feat/outside']);

      const output = await logJson(dir);
      const stackRoot = output.stacks[0]?.root;
      expect(stackRoot?.region).toBe('root');
      const base = stackRoot?.children[0];
      expect(base?.region).toBe('descendant');
    });

    it('keeps region markers correct under --reverse', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'feat/auth-login']);

      const output = await log(dir, { reverse: true });
      // Under --reverse, feat/auth-sibling renders before feat/auth-login,
      // but the markers (>, *, ~) must still reflect each branch's region.
      expect(output).toContain('├─ ~feat/auth-sibling~');
      expect(output).toContain('└─ *feat/auth-login (Current)*');
      expect(output).toContain('>feat/auth-base');
    });

    it('renders root as `(name)` even when the user is on the root', async () => {
      await buildTree(dir);
      await gitInRepo(dir, ['checkout', 'main']);

      const output = await log(dir);
      // Root precedence: even though current === root, the label stays `(main)`
      // and the JSON `current` flag carries the "I'm here" signal.
      expect(output).toMatch(/^\(main\)/);
      expect(output).not.toContain('*main');

      const json = await logJson(dir);
      const stackRoot = json.stacks[0]?.root;
      expect(stackRoot?.region).toBe('root');
      expect(stackRoot?.current).toBe(true);
    });
  });

  describe('computeRegions', () => {
    function buildStack(): Stack {
      return {
        id: 'stack-1',
        branches: [
          {
            name: 'main',
            type: 'root',
            parent: null,
            pr_number: null,
            pr_link: null,
          },
          { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          { name: 'feat/a1', parent: 'feat/a', pr_number: null, pr_link: null },
          { name: 'feat/a2', parent: 'feat/a', pr_number: null, pr_link: null },
          { name: 'feat/b', parent: 'main', pr_number: null, pr_link: null },
        ],
      };
    }

    it('tags every branch around the current node correctly', () => {
      const regions = computeRegions(buildStack(), 'feat/a1');
      expect(regions.get('main')).toBe('root');
      expect(regions.get('feat/a')).toBe('ancestor');
      expect(regions.get('feat/a1')).toBe('current');
      expect(regions.get('feat/a2')).toBe('sibling-subtree');
      expect(regions.get('feat/b')).toBe('sibling-subtree');
    });

    it('keeps the root region when the current branch is the root', () => {
      const regions = computeRegions(buildStack(), 'main');
      expect(regions.get('main')).toBe('root');
      // Children of root with no descendant relationship to "main as current"
      // become descendants because main IS the current.
      expect(regions.get('feat/a')).toBe('descendant');
      expect(regions.get('feat/a1')).toBe('descendant');
    });

    it('marks every non-root branch as descendant when current is null', () => {
      const regions = computeRegions(buildStack(), null);
      expect(regions.get('main')).toBe('root');
      expect(regions.get('feat/a')).toBe('descendant');
      expect(regions.get('feat/b')).toBe('descendant');
    });

    it('marks every non-root branch as descendant when current is not in the stack', () => {
      const regions = computeRegions(buildStack(), 'feat/orphan');
      expect(regions.get('main')).toBe('root');
      expect(regions.get('feat/a')).toBe('descendant');
    });

    it('does not double-process descendants reachable via two paths', () => {
      // Diamond topology — feat/d listed twice as a child via cyclic parents.
      // The BFS visited-set must prevent infinite work.
      const diamond: Stack = {
        id: 'stack-diamond',
        branches: [
          {
            name: 'main',
            type: 'root',
            parent: null,
            pr_number: null,
            pr_link: null,
          },
          { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          { name: 'feat/b', parent: 'feat/a', pr_number: null, pr_link: null },
          // Malformed: feat/c lists feat/b as parent but feat/b also points to feat/c.
          { name: 'feat/c', parent: 'feat/b', pr_number: null, pr_link: null },
        ],
      };
      const regions = computeRegions(diamond, 'feat/a');
      expect(regions.get('feat/a')).toBe('current');
      expect(regions.get('feat/b')).toBe('descendant');
      expect(regions.get('feat/c')).toBe('descendant');
    });

    it('terminates on a parent cycle without hanging', () => {
      const cyclic: Stack = {
        id: 'stack-cycle',
        branches: [
          {
            name: 'main',
            type: 'root',
            parent: null,
            pr_number: null,
            pr_link: null,
          },
          // Mutual parents — invalid state but must not loop forever.
          { name: 'feat/a', parent: 'feat/b', pr_number: null, pr_link: null },
          { name: 'feat/b', parent: 'feat/a', pr_number: null, pr_link: null },
        ],
      };
      const regions = computeRegions(cyclic, 'feat/a');
      expect(regions.get('feat/a')).toBe('current');
      expect(regions.get('feat/b')).toBe('ancestor');
    });
  });

  describe('rich overview', () => {
    function makeBranchOverview(
      branch: string,
      parent: string | null,
      overrides: Partial<BranchOverview> = {},
    ): BranchOverview {
      return {
        branch,
        parent,
        isRoot: parent === null,
        pr: null,
        commit: null,
        prLink: null,
        lastSyncedAt: null,
        syncSource: null,
        ...overrides,
      };
    }

    function makeOverview(branches: BranchOverview[]): StackOverview {
      return {
        branches,
        truncated: false,
        cachedAt: new Date('2026-05-24T00:00:00Z').toISOString(),
      };
    }

    async function seedLinearStack() {
      await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
      await gitInRepo(dir, ['checkout', '-b', 'feat/b']);
      const state: DubState = {
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
                pr_number: 42,
                pr_link: 'https://github.com/example/repo/pull/42',
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
      await writeState(state, dir);
    }

    it('renders PR + CI + commit annotations after the label for a linear stack', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null, {
          commit: {
            committedRel: '2 days ago',
            authorEmail: 'a@x',
            shortSha: 'mainabcd',
          },
        }),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
          prLink: 'https://github.com/example/repo/pull/42',
          commit: {
            committedRel: '1 hour ago',
            authorEmail: 'a@x',
            shortSha: 'aaaa1111',
          },
        }),
        makeBranchOverview('feat/b', 'feat/a', {
          commit: {
            committedRel: 'just now',
            authorEmail: 'a@x',
            shortSha: 'bbbb2222',
          },
        }),
      ]);

      const output = await log(dir, { overview, noColor: true });
      expect(output).toContain('>feat/a  #42 ✔ approved · ✔ ci');
      expect(output).toContain('1 hour ago');
      expect(output).toContain('aaaa1111');
      // No PR but still gets commit info
      expect(output).toContain('*feat/b (Current)*  just now · bbbb2222');
      // Root keeps the parens label and gets commit info appended
      expect(output).toMatch(/^\(main\) {2}2 days ago · mainabcd/);
      // No ANSI escape codes in no-color mode
      expect(output.includes('\x1b')).toBe(false);
    });

    it('hides PR annotations under --no-prs but keeps CI + commit', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
          commit: {
            committedRel: '1 hour ago',
            authorEmail: 'a@x',
            shortSha: 'aaaa1111',
          },
        }),
        makeBranchOverview('feat/b', 'feat/a'),
      ]);

      const output = await log(dir, {
        overview,
        prs: false,
        noColor: true,
      });
      expect(output).not.toContain('#42');
      expect(output).not.toContain('approved');
      expect(output).toContain('✔ ci');
      expect(output).toContain('1 hour ago');
    });

    it('hides CI annotations under --no-ci but keeps PR + commit', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
          commit: {
            committedRel: '1 hour ago',
            authorEmail: 'a@x',
            shortSha: 'aaaa1111',
          },
        }),
        makeBranchOverview('feat/b', 'feat/a'),
      ]);

      const output = await log(dir, {
        overview,
        ci: false,
        noColor: true,
      });
      expect(output).toContain('#42');
      expect(output).toContain('✔ approved');
      expect(output).not.toContain('✔ ci');
      expect(output).toContain('1 hour ago');
    });

    it('omits PR JSON fields under --no-prs but keeps CI and commit metadata', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
          commit: {
            committedRel: '1 hour ago',
            authorEmail: 'a@x',
            shortSha: 'aaaa1111',
          },
        }),
        makeBranchOverview('feat/b', 'feat/a'),
      ]);

      const json = await logJson(dir, { overview, prs: false });
      const featA = json.stacks[0]?.root?.children[0];
      expect(featA).not.toHaveProperty('prState');
      expect(featA).not.toHaveProperty('prTitle');
      expect(featA).not.toHaveProperty('reviewDecision');
      expect(featA).not.toHaveProperty('draft');
      expect(featA?.ciState).toBe('SUCCESS');
      expect(featA?.committedRel).toBe('1 hour ago');
      expect(featA?.shortSha).toBe('aaaa1111');
      // Branch with overview but no PR also drops the explicit NONE fields.
      const featB = featA?.children[0];
      expect(featB).not.toHaveProperty('prState');
      expect(featB).not.toHaveProperty('reviewDecision');
      expect(featB).not.toHaveProperty('draft');
      expect(featB?.ciState).toBe('NONE');
    });

    it('omits CI JSON field under --no-ci but keeps PR fields and commit metadata', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
          commit: {
            committedRel: '1 hour ago',
            authorEmail: 'a@x',
            shortSha: 'aaaa1111',
          },
        }),
        makeBranchOverview('feat/b', 'feat/a'),
      ]);

      const json = await logJson(dir, { overview, ci: false });
      const featA = json.stacks[0]?.root?.children[0];
      expect(featA?.prState).toBe('OPEN');
      expect(featA?.reviewDecision).toBe('APPROVED');
      expect(featA?.draft).toBe(false);
      expect(featA).not.toHaveProperty('ciState');
      expect(featA?.committedRel).toBe('1 hour ago');
    });

    it('renders the correct PR-state glyph for draft, merged, closed, and changes-requested', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: null,
            ciRollup: 'NONE',
            // Draft beats reviewDecision in the glyph hierarchy.
            isDraft: true,
          },
        }),
      ]);
      let output = await log(dir, { overview, noColor: true });
      expect(output).toContain('✏ draft');

      overview.branches[1].pr = {
        number: 42,
        title: 'feat: a',
        state: 'MERGED',
        baseRefName: 'main',
        mergedAt: '2026-05-23T00:00:00Z',
        reviewDecision: 'APPROVED',
        ciRollup: 'SUCCESS',
        isDraft: false,
      };
      output = await log(dir, { overview, noColor: true });
      expect(output).toContain('⤓ merged');

      overview.branches[1].pr = {
        number: 42,
        title: 'feat: a',
        state: 'CLOSED',
        baseRefName: 'main',
        mergedAt: null,
        reviewDecision: null,
        ciRollup: 'NONE',
        isDraft: false,
      };
      output = await log(dir, { overview, noColor: true });
      expect(output).toContain('⊘ closed');

      overview.branches[1].pr = {
        number: 42,
        title: 'feat: a',
        state: 'OPEN',
        baseRefName: 'main',
        mergedAt: null,
        reviewDecision: 'CHANGES_REQUESTED',
        ciRollup: 'FAILURE',
        isDraft: false,
      };
      output = await log(dir, { overview, noColor: true });
      expect(output).toContain('✗ changes requested');
      expect(output).toContain('✗ ci');
    });

    it('falls back to the plain region-only tree when overview is null', async () => {
      await seedLinearStack();
      const output = await log(dir, { overview: null });
      // Must match the existing region-only output exactly.
      expect(output).toBe('(main)\n  └─ >feat/a\n       └─ *feat/b (Current)*');
    });

    it('emits the rich JSON fields when overview is provided', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
          commit: {
            committedRel: '1 hour ago',
            authorEmail: 'a@x',
            shortSha: 'aaaa1111',
          },
        }),
        makeBranchOverview('feat/b', 'feat/a'),
      ]);

      const json = await logJson(dir, { overview });
      const root = json.stacks[0]?.root;
      const featA = root?.children[0];
      expect(featA?.prState).toBe('OPEN');
      expect(featA?.prTitle).toBe('feat: a');
      expect(featA?.reviewDecision).toBe('APPROVED');
      expect(featA?.ciState).toBe('SUCCESS');
      expect(featA?.draft).toBe(false);
      expect(featA?.committedRel).toBe('1 hour ago');
      expect(featA?.shortSha).toBe('aaaa1111');
      // frozen is always present (DUB-37); false for unfrozen branches.
      expect(featA?.frozen).toBe(false);
      // Tracked branch present in overview but with no PR — explicit NONE,
      // not undefined, so consumers can distinguish "no overview" from "no PR".
      const featB = featA?.children[0];
      expect(featB?.prState).toBe('NONE');
      expect(featB?.ciState).toBe('NONE');
      expect(featB?.draft).toBe(false);
      expect(featB?.reviewDecision).toBeNull();

      expect(json.overviewTruncated).toBe(false);
    });

    it('omits rich JSON fields when overview is absent so consumers see additive-only shape', async () => {
      await seedLinearStack();
      const json = await logJson(dir, {});
      const featA = json.stacks[0]?.root?.children[0];
      expect(featA?.name).toBe('feat/a');
      // Old fields still present
      expect(featA?.prNumber).toBe(42);
      expect(featA?.prLink).toBe('https://github.com/example/repo/pull/42');
      expect(featA?.region).toBe('ancestor');
      // New fields strictly omitted
      expect(featA).not.toHaveProperty('prState');
      expect(featA).not.toHaveProperty('ciState');
      expect(featA).not.toHaveProperty('committedRel');
      expect(json.overviewTruncated).toBeUndefined();
    });

    it('applies ANSI styling to suffix tokens when noColor is false', async () => {
      await seedLinearStack();
      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 42,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
        }),
        makeBranchOverview('feat/b', 'feat/a'),
      ]);

      const originalLevel = chalk.level;
      chalk.level = 1;
      try {
        const output = await log(dir, { overview, noColor: false });
        // ANSI escape codes appear in the suffix.
        expect(output.includes('\x1b')).toBe(true);
        // But the styling decision is local to the suffix chalk instance;
        // explicit noColor: true on the same input strips them.
        const noAnsi = await log(dir, { overview, noColor: true });
        expect(noAnsi.includes('\x1b')).toBe(false);
      } finally {
        chalk.level = originalLevel;
      }
    });

    it('renders rich annotations on a branching tree', async () => {
      await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
      await gitInRepo(dir, ['checkout', 'main']);
      await gitInRepo(dir, ['checkout', '-b', 'feat/b']);
      const state: DubState = {
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
                parent: 'main',
                pr_number: null,
                pr_link: null,
              },
            ],
          },
        ],
      };
      await writeState(state, dir);

      const overview = makeOverview([
        makeBranchOverview('main', null),
        makeBranchOverview('feat/a', 'main', {
          pr: {
            number: 10,
            title: 'feat: a',
            state: 'OPEN',
            baseRefName: 'main',
            mergedAt: null,
            reviewDecision: 'REVIEW_REQUIRED',
            ciRollup: 'PENDING',
            isDraft: false,
          },
        }),
        makeBranchOverview('feat/b', 'main', {
          pr: {
            number: 11,
            title: 'feat: b',
            state: 'MERGED',
            baseRefName: 'main',
            mergedAt: '2026-05-23T00:00:00Z',
            reviewDecision: 'APPROVED',
            ciRollup: 'SUCCESS',
            isDraft: false,
          },
        }),
      ]);

      const output = await log(dir, { overview, noColor: true });
      // feat/a (sibling of current feat/b) gets "review pending"
      expect(output).toContain('~feat/a~  #10 ⏳ review pending · ⏳ ci');
      // feat/b (current) gets "merged"
      expect(output).toContain('*feat/b (Current)*  #11 ⤓ merged · ✔ ci');
    });
  });

  describe('styleLogOutput', () => {
    const sample = [
      '(main)',
      '  └─ >feat/a',
      '       ├─ *feat/b (Current)*',
      '       └─ ~feat/c~',
      '            └─ ~feat/c-leaf~ ⚠ (missing)',
    ].join('\n');

    it('keeps `*` and `>` markers and strips `~` in no-color mode', () => {
      const out = styleLogOutput(sample, true);
      expect(out).toContain('*feat/b (Current)*');
      expect(out).toContain('>feat/a');
      expect(out).toContain('feat/c\n');
      expect(out).not.toContain('~feat/c~');
      expect(out).not.toContain('~feat/c-leaf~');
      expect(out).toContain('⚠ (missing)');
      // No ANSI escape sequences should appear.
      expect(out.includes('\x1b')).toBe(false);
    });

    it('replaces markers with ANSI codes in color mode', () => {
      // Mutating chalk.level is safe here because vitest isolates each test
      // file (default `isolate: true`), so the singleton lives in its own
      // module graph; the try/finally restores in-file ordering.
      const originalLevel = chalk.level;
      chalk.level = 1;
      try {
        const out = styleLogOutput(sample, false);
        // Plain markers are gone…
        expect(out).not.toContain('*feat/b (Current)*');
        expect(out).not.toContain('~feat/c~');
        // …but the branch names survive and ANSI codes wrap them.
        expect(out).toContain('feat/b (Current)');
        expect(out).toContain('feat/c');
        expect(out.includes('\x1b')).toBe(true);
      } finally {
        chalk.level = originalLevel;
      }
    });

    it('does not mis-style branch names that happen to follow `─ >`', () => {
      const originalLevel = chalk.level;
      chalk.level = 1;
      try {
        const out = styleLogOutput('  └─ >feat/scoped-name', false);
        // Ensure only the branch name is captured, not anything beyond whitespace.
        expect(out).toContain('feat/scoped-name');
        expect(out).not.toContain('>feat/scoped-name');
      } finally {
        chalk.level = originalLevel;
      }
    });

    it('composes ancestor + missing markers in both modes', () => {
      const line = '  └─ >feat/a ⚠ (missing)';
      const noColorOut = styleLogOutput(line, true);
      expect(noColorOut).toBe(line);

      const originalLevel = chalk.level;
      chalk.level = 1;
      try {
        const colorOut = styleLogOutput(line, false);
        // Branch name keeps text, no raw marker, and warning is preserved.
        expect(colorOut).not.toContain('>feat/a');
        expect(colorOut).toContain('feat/a');
        expect(colorOut).toContain('⚠ (missing)');
        expect(colorOut.includes('\x1b')).toBe(true);
      } finally {
        chalk.level = originalLevel;
      }
    });
  });
});
