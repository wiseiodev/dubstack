import { describe, expect, it } from 'vitest';
import { parseDubstackMetadata as canonicalParse } from '../../cli/src/lib/pr-body.js';
import { parseDubstackMetadata as bundledParse } from '../src/pr-body-parser.js';
import { buildStackFakes, type FakePullBranch } from './helpers.js';

/**
 * Shared fixture set for the parser-sync test. Each entry is a real PR body
 * string. The two parsers must produce identical output, byte-for-byte
 * (via JSON.stringify), for every entry. If you change the canonical parser
 * in packages/cli/src/lib/pr-body.ts, copy the change into
 * packages/retarget-action/src/pr-body-parser.ts and rerun this test.
 */
function buildFixtures(): { name: string; body: string }[] {
  const linear: FakePullBranch[] = [
    { number: 0, branch: 'main', parent: null, depth: 0 },
    { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
    { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
    { number: 3, branch: 'feat/c', parent: 'feat/b', depth: 3 },
  ];
  const tree: FakePullBranch[] = [
    { number: 0, branch: 'main', parent: null, depth: 0 },
    { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
    { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
    { number: 3, branch: 'feat/c', parent: 'feat/b', depth: 3 },
    { number: 4, branch: 'feat/d', parent: 'feat/a', depth: 2 },
  ];

  const linearFakes = buildStackFakes({
    stackId: 'stk_linear',
    trunk: 'main',
    branches: linear,
  });
  const treeFakes = buildStackFakes({
    stackId: 'stk_tree',
    trunk: 'main',
    branches: tree,
  });

  return [
    {
      name: 'linear-stack/feat-a',
      body: linearFakes.bodyByBranch.get('feat/a') ?? '',
    },
    {
      name: 'linear-stack/feat-c',
      body: linearFakes.bodyByBranch.get('feat/c') ?? '',
    },
    {
      name: 'tree-stack/feat-b',
      body: treeFakes.bodyByBranch.get('feat/b') ?? '',
    },
    {
      name: 'tree-stack/feat-d',
      body: treeFakes.bodyByBranch.get('feat/d') ?? '',
    },
    {
      name: 'no-metadata',
      body: '## Summary\n\nA PR with no dubstack tags.',
    },
    {
      name: 'malformed-json',
      body: '<!-- dubstack-metadata\n{ this is not json }\n-->',
    },
    {
      name: 'missing-required-field',
      body: `<!-- dubstack-metadata\n${JSON.stringify({
        stack_id: 'stk',
        pr_number: 1,
        // missing `branch`
        prev_pr: null,
        next_pr: null,
      })}\n-->`,
    },
    {
      name: 'legacy-shape',
      body: `<!-- dubstack-metadata\n${JSON.stringify(
        {
          stack_id: 'stk',
          pr_number: 7,
          branch: 'feat/legacy',
          prev_pr: null,
          next_pr: null,
        },
        null,
        2,
      )}\n-->`,
    },
  ];
}

describe('parser sync: bundled parser matches canonical CLI parser', () => {
  const fixtures = buildFixtures();

  for (const fixture of fixtures) {
    it(`produces identical output for ${fixture.name}`, () => {
      const canonical = canonicalParse(fixture.body);
      const bundled = bundledParse(fixture.body);
      expect(JSON.stringify(bundled)).toBe(JSON.stringify(canonical));
    });
  }
});
