import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
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
