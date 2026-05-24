import { describe, expect, it } from 'vitest';
import {
  buildAiSummarySection,
  buildMetadataBlock,
  buildMetadataTree,
  buildStackTable,
  composePrBody,
  type DubstackMetadata,
  parseDubstackMetadata,
  stripAiSummarySection,
  stripDubstackSections,
} from './pr-body';
import type { Branch } from './state';

function branch(name: string, parent: string | null): Branch {
  return { name, parent, pr_number: null, pr_link: null };
}

function root(name: string): Branch {
  return { name, type: 'root', parent: null, pr_number: null, pr_link: null };
}

describe('buildStackTable', () => {
  it('builds a tree for a linear stack rooted at main', () => {
    const branches = [
      root('main'),
      branch('feat/api', 'main'),
      branch('feat/ui', 'feat/api'),
    ];
    const prMap = new Map([
      ['feat/api', { number: 101, title: 'feat: api' }],
      ['feat/ui', { number: 102, title: 'feat: ui' }],
    ]);

    const result = buildStackTable(branches, prMap, 'feat/ui');

    expect(result).toContain('### 🥞 DubStack');
    expect(result).toContain('- main');
    expect(result).toContain('  - #101 feat: api');
    expect(result).toContain('    - #102 feat: ui 👈');
    expect(result).toContain('<!-- dubstack:start -->');
    expect(result).toContain('<!-- dubstack:end -->');
  });

  it('marks the correct branch with 👈', () => {
    const branches = [root('main'), branch('a', 'main'), branch('b', 'a')];
    const prMap = new Map([
      ['a', { number: 1, title: 'A' }],
      ['b', { number: 2, title: 'B' }],
    ]);

    const result = buildStackTable(branches, prMap, 'a');

    expect(result).toContain('- #1 A 👈');
    expect(result).not.toContain('- #2 B 👈');
  });

  it('handles a single-branch stack', () => {
    const branches = [root('main'), branch('feat/solo', 'main')];
    const prMap = new Map([
      ['feat/solo', { number: 42, title: 'solo change' }],
    ]);

    const result = buildStackTable(branches, prMap, 'feat/solo');

    expect(result).toContain('  - #42 solo change 👈');
  });

  it('renders a 3-sibling tree with alphabetical sibling order', () => {
    const branches = [
      root('main'),
      branch('feat/auth-base', 'main'),
      branch('feat/auth-tests', 'feat/auth-base'),
      branch('feat/auth-login', 'feat/auth-base'),
      branch('feat/auth-signup', 'feat/auth-base'),
    ];
    const prMap = new Map([
      ['feat/auth-base', { number: 100, title: 'feat/auth-base' }],
      ['feat/auth-login', { number: 101, title: 'feat/auth-login' }],
      ['feat/auth-signup', { number: 102, title: 'feat/auth-signup' }],
      ['feat/auth-tests', { number: 103, title: 'feat/auth-tests' }],
    ]);

    const result = buildStackTable(branches, prMap, 'feat/auth-login');

    expect(result).toMatchInlineSnapshot(`
      "<!-- dubstack:start -->
      ---
      ### 🥞 DubStack
      - main
        - #100 feat/auth-base
          - #101 feat/auth-login 👈
          - #102 feat/auth-signup
          - #103 feat/auth-tests
      <!-- dubstack:end -->"
    `);
  });

  it('renders a 5-deep linear stack', () => {
    const branches = [
      root('main'),
      branch('feat/l1', 'main'),
      branch('feat/l2', 'feat/l1'),
      branch('feat/l3', 'feat/l2'),
      branch('feat/l4', 'feat/l3'),
      branch('feat/l5', 'feat/l4'),
    ];
    const prMap = new Map([
      ['feat/l1', { number: 1, title: 'l1' }],
      ['feat/l2', { number: 2, title: 'l2' }],
      ['feat/l3', { number: 3, title: 'l3' }],
      ['feat/l4', { number: 4, title: 'l4' }],
      ['feat/l5', { number: 5, title: 'l5' }],
    ]);

    const result = buildStackTable(branches, prMap, 'feat/l3');

    expect(result).toMatchInlineSnapshot(`
      "<!-- dubstack:start -->
      ---
      ### 🥞 DubStack
      - main
        - #1 l1
          - #2 l2
            - #3 l3 👈
              - #4 l4
                - #5 l5
      <!-- dubstack:end -->"
    `);
  });

  it('truncates stacks larger than 40 branches', () => {
    const branches: Branch[] = [root('main')];
    // 41 children of main → > 40 non-root, > 40 total too
    for (let i = 0; i < 41; i++) {
      branches.push(branch(`feat/b${String(i).padStart(2, '0')}`, 'main'));
    }
    // Add deep descendants under one sibling (feat/b40) — should still render
    branches.push(branch('feat/b40-child', 'feat/b40'));
    branches.push(branch('feat/b40-grand', 'feat/b40-child'));

    const prMap = new Map<string, { number: number; title: string }>();
    for (let i = 0; i < 41; i++) {
      const name = `feat/b${String(i).padStart(2, '0')}`;
      prMap.set(name, { number: 200 + i, title: name });
    }
    prMap.set('feat/b40-child', { number: 999, title: 'feat/b40-child' });
    prMap.set('feat/b40-grand', { number: 1000, title: 'feat/b40-grand' });

    const result = buildStackTable(branches, prMap, 'feat/b40');

    // Current branch + ancestors (main) + siblings (b00..b40) all visible.
    // Descendants of current branch visible.
    expect(result).toContain('- main');
    expect(result).toContain('  - #240 feat/b40 👈');
    expect(result).toContain('    - #999 feat/b40-child');
    expect(result).toContain('      - #1000 feat/b40-grand');
    // Siblings shown
    expect(result).toContain('  - #200 feat/b00');
    // Sibling sub-descendants not hidden in this fixture (none exist),
    // so no truncation marker for this case.
    expect(result).not.toContain('branches hidden');
  });

  it('shows hidden-count summary when siblings have hidden descendants', () => {
    // 41 siblings, each with a hidden grandchild → 41 hidden descendants
    const branches: Branch[] = [root('main')];
    for (let i = 0; i < 41; i++) {
      const sib = `feat/sib${String(i).padStart(2, '0')}`;
      branches.push(branch(sib, 'main'));
      branches.push(branch(`${sib}-deep`, sib));
    }
    const prMap = new Map<string, { number: number; title: string }>();
    for (const b of branches) {
      if (b.type !== 'root') {
        prMap.set(b.name, { number: 0, title: b.name });
      }
    }

    const result = buildStackTable(branches, prMap, 'feat/sib00');

    expect(result).toContain(
      "... (40 branches hidden, run 'dub log' to see all)",
    );
    // Current branch is rendered with its descendant; deep descendants of
    // every other sibling are hidden (one per sibling = 40 hidden).
    expect(result).toContain('  - #0 feat/sib00 👈');
    expect(result).toContain('    - #0 feat/sib00-deep');
    expect(result).not.toContain('feat/sib01-deep');
  });
});

describe('buildMetadataBlock', () => {
  it('serializes a v1 metadata block', () => {
    const metadata: DubstackMetadata = {
      schema_version: 1,
      stack_id: 'uuid-1',
      pr_number: 102,
      branch: 'feat/ui',
      parent: 'feat/api',
      children: [],
      siblings: ['feat/ui-alt'],
      prev_pr: 101,
      next_pr: 103,
      tree: [
        { name: 'main', depth: 0 },
        { name: 'feat/api', depth: 1, pr_number: 101 },
        { name: 'feat/ui', depth: 2, pr_number: 102, is_current: true },
      ],
    };
    const result = buildMetadataBlock(metadata);

    expect(result).toContain('<!-- dubstack-metadata');
    expect(result).toContain('-->');
    expect(result).toContain('"schema_version": 1');
    expect(result).toContain('"stack_id": "uuid-1"');
    expect(result).toContain('"pr_number": 102');
    expect(result).toContain('"prev_pr": 101');
    expect(result).toContain('"next_pr": 103');
    expect(result).toContain('"parent": "feat/api"');
    expect(result).toContain('"siblings"');
    expect(result).toContain('"tree"');
    expect(result).toContain('"is_current": true');
  });

  it('handles null prev/next and parent for a root-child', () => {
    const metadata: DubstackMetadata = {
      schema_version: 1,
      stack_id: 'uuid-2',
      pr_number: 42,
      branch: 'feat/solo',
      parent: 'main',
      children: [],
      siblings: [],
      prev_pr: null,
      next_pr: null,
      tree: [
        { name: 'main', depth: 0 },
        { name: 'feat/solo', depth: 1, pr_number: 42, is_current: true },
      ],
    };
    const result = buildMetadataBlock(metadata);

    expect(result).toContain('"prev_pr": null');
    expect(result).toContain('"next_pr": null');
  });
});

describe('buildMetadataTree', () => {
  it('emits depth-tagged flat tree with current marker', () => {
    const branches = [
      root('main'),
      branch('feat/a', 'main'),
      branch('feat/b', 'feat/a'),
      branch('feat/c', 'feat/a'),
    ];
    const prMap = new Map([
      ['feat/a', { number: 1, title: 'a' }],
      ['feat/b', { number: 2, title: 'b' }],
      ['feat/c', { number: 3, title: 'c' }],
    ]);

    const result = buildMetadataTree(branches, prMap, 'feat/b');

    expect(result).toEqual([
      { name: 'main', depth: 0 },
      { name: 'feat/a', depth: 1, pr_number: 1 },
      { name: 'feat/b', depth: 2, pr_number: 2, is_current: true },
      { name: 'feat/c', depth: 2, pr_number: 3 },
    ]);
  });
});

describe('stripDubstackSections', () => {
  it('removes dubstack markers and content', () => {
    const body = [
      'User description here',
      '<!-- dubstack:start -->',
      '---',
      '### 🥞 DubStack',
      '- #101 feat: api',
      '<!-- dubstack:end -->',
      '<!-- dubstack-metadata',
      '{ "stack_id": "x" }',
      '-->',
    ].join('\n');

    const result = stripDubstackSections(body);

    expect(result).toBe('User description here');
  });

  it('returns body unchanged if no markers exist', () => {
    const body = 'Just a normal PR description';
    expect(stripDubstackSections(body)).toBe(body);
  });

  it('is idempotent — double-strip returns same result', () => {
    const body =
      'Description\n<!-- dubstack:start -->\nstuff\n<!-- dubstack:end -->';
    const first = stripDubstackSections(body);
    const second = stripDubstackSections(first);
    expect(second).toBe(first);
  });
});

describe('composePrBody', () => {
  it('combines user content with ai summary and stack sections', () => {
    const result = composePrBody(
      'My PR',
      'AI summary',
      'STACK_TABLE',
      'META_BLOCK',
    );

    expect(result).toBe(
      [
        'My PR',
        buildAiSummarySection('AI summary'),
        'STACK_TABLE',
        'META_BLOCK',
      ].join('\n\n'),
    );
  });

  it('replaces stale ai summary and dubstack sections before composing', () => {
    const existingBody = [
      'My PR',
      buildAiSummarySection('Old summary'),
      '<!-- dubstack:start -->',
      'old table',
      '<!-- dubstack:end -->',
      '',
      '<!-- dubstack-metadata',
      'old meta',
      '-->',
    ].join('\n');

    const result = composePrBody(
      existingBody,
      'New summary',
      'NEW_TABLE',
      'NEW_META',
    );

    expect(result).toBe(
      [
        'My PR',
        buildAiSummarySection('New summary'),
        'NEW_TABLE',
        'NEW_META',
      ].join('\n\n'),
    );
  });

  it('handles empty existing body', () => {
    const result = composePrBody('', 'Summary', 'TABLE', 'META');

    expect(result).toBe(
      [buildAiSummarySection('Summary'), 'TABLE', 'META'].join('\n\n'),
    );
  });

  it('preserves user-authored content around ai-managed sections', () => {
    const existingBody = [
      'User intro',
      '',
      buildAiSummarySection('Old summary'),
      '',
      'Extra author note',
      '',
      '<!-- dubstack:start -->',
      'old table',
      '<!-- dubstack:end -->',
      '',
      '<!-- dubstack-metadata',
      'old meta',
      '-->',
    ].join('\n');

    const result = composePrBody(
      existingBody,
      'Fresh summary',
      'TABLE',
      'META',
    );

    expect(result).toContain('User intro\n\nExtra author note');
    expect(result).toContain(buildAiSummarySection('Fresh summary'));
    expect(result).toContain('TABLE');
    expect(result).toContain('META');
  });
});

describe('AI summary helpers', () => {
  it('wraps ai summary content in replaceable markers', () => {
    const result = buildAiSummarySection('Summary text');

    expect(result).toContain('<!-- dubstack-ai-summary:start -->');
    expect(result).toContain('Summary text');
    expect(result).toContain('<!-- dubstack-ai-summary:end -->');
  });

  it('strips only the ai-managed summary section', () => {
    const body = [
      'User intro',
      '',
      buildAiSummarySection('Generated summary'),
      '',
      'User footer',
    ].join('\n');

    expect(stripAiSummarySection(body)).toBe('User intro\n\nUser footer');
  });

  it('strips duplicate ai-managed summary sections without leaving stale text behind', () => {
    const body = [
      'User intro',
      '',
      buildAiSummarySection('Generated summary'),
      '',
      'User middle',
      '',
      buildAiSummarySection('Older generated summary'),
      '',
      'User footer',
    ].join('\n');

    expect(stripAiSummarySection(body)).toBe(
      'User intro\n\nUser middle\n\nUser footer',
    );
  });

  it('ignores unmatched end markers that appear before a valid ai summary block', () => {
    const body = [
      'User intro',
      '',
      '<!-- dubstack-ai-summary:end -->',
      '',
      buildAiSummarySection('Generated summary'),
      '',
      'User footer',
    ].join('\n');

    expect(stripAiSummarySection(body)).toBe(
      [
        'User intro',
        '',
        '<!-- dubstack-ai-summary:end -->',
        '',
        'User footer',
      ].join('\n'),
    );
  });
});

describe('parseDubstackMetadata', () => {
  it('parses a v1 metadata block from a composed PR body', () => {
    const meta: DubstackMetadata = {
      schema_version: 1,
      stack_id: 'stack-1',
      pr_number: 12,
      branch: 'feat/a',
      parent: 'main',
      children: ['feat/a-child'],
      siblings: ['feat/b'],
      prev_pr: 11,
      next_pr: 13,
      tree: [
        { name: 'main', depth: 0 },
        { name: 'feat/a', depth: 1, pr_number: 12, is_current: true },
      ],
    };
    const body = composePrBody(
      'My description',
      '',
      'STACK',
      buildMetadataBlock(meta),
    );

    expect(parseDubstackMetadata(body)).toEqual(meta);
  });

  it('migrates a legacy (pre-v1) metadata block to v1 with empty tree fields', () => {
    // Legacy shape: no schema_version, no parent/children/siblings/tree.
    const legacyBody = [
      'desc',
      '<!-- dubstack-metadata',
      JSON.stringify(
        {
          stack_id: 'legacy-1',
          pr_number: 12,
          prev_pr: 11,
          next_pr: 13,
          branch: 'feat/a',
        },
        null,
        2,
      ),
      '-->',
    ].join('\n');

    expect(parseDubstackMetadata(legacyBody)).toEqual({
      schema_version: 1,
      stack_id: 'legacy-1',
      pr_number: 12,
      branch: 'feat/a',
      parent: null,
      children: [],
      siblings: [],
      prev_pr: 11,
      next_pr: 13,
      tree: [],
    });
  });

  it('returns null when metadata block is missing', () => {
    expect(parseDubstackMetadata('no metadata here')).toBeNull();
  });

  it('returns null when metadata JSON is invalid', () => {
    const broken = 'text\n<!-- dubstack-metadata\n{ nope }\n-->';
    expect(parseDubstackMetadata(broken)).toBeNull();
  });

  it('returns null when schema_version is unknown', () => {
    const body = [
      '<!-- dubstack-metadata',
      JSON.stringify(
        {
          schema_version: 999,
          stack_id: 's',
          pr_number: 1,
          prev_pr: null,
          next_pr: null,
          branch: 'feat/a',
        },
        null,
        2,
      ),
      '-->',
    ].join('\n');
    expect(parseDubstackMetadata(body)).toBeNull();
  });
});
