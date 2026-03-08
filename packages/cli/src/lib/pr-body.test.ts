import { describe, expect, it } from 'vitest';
import {
  buildAiSummarySection,
  buildMetadataBlock,
  buildStackTable,
  composePrBody,
  parseDubstackMetadata,
  stripAiSummarySection,
  stripDubstackSections,
} from './pr-body';
import type { Branch } from './state';

function branch(name: string, parent: string): Branch {
  return { name, parent, pr_number: null, pr_link: null };
}

describe('buildStackTable', () => {
  it('builds a table for a multi-branch stack', () => {
    const branches = [
      branch('feat/api', 'main'),
      branch('feat/ui', 'feat/api'),
    ];
    const prMap = new Map([
      ['feat/api', { number: 101, title: 'feat: api' }],
      ['feat/ui', { number: 102, title: 'feat: ui' }],
    ]);

    const result = buildStackTable(branches, prMap, 'feat/ui');

    expect(result).toContain('### 🥞 DubStack');
    expect(result).toContain('- #101 feat: api');
    expect(result).toContain('- #102 feat: ui 👈');
    expect(result).toContain('<!-- dubstack:start -->');
    expect(result).toContain('<!-- dubstack:end -->');
  });

  it('marks the correct branch with 👈', () => {
    const branches = [branch('a', 'main'), branch('b', 'a')];
    const prMap = new Map([
      ['a', { number: 1, title: 'A' }],
      ['b', { number: 2, title: 'B' }],
    ]);

    const result = buildStackTable(branches, prMap, 'a');

    expect(result).toContain('- #1 A 👈');
    expect(result).not.toContain('- #2 B 👈');
  });

  it('handles a single-branch stack', () => {
    const branches = [branch('feat/solo', 'main')];
    const prMap = new Map([
      ['feat/solo', { number: 42, title: 'solo change' }],
    ]);

    const result = buildStackTable(branches, prMap, 'feat/solo');

    expect(result).toContain('- #42 solo change 👈');
  });
});

describe('buildMetadataBlock', () => {
  it('produces valid metadata comment', () => {
    const result = buildMetadataBlock('uuid-1', 102, 101, 103, 'feat/ui');

    expect(result).toContain('<!-- dubstack-metadata');
    expect(result).toContain('-->');
    expect(result).toContain('"stack_id": "uuid-1"');
    expect(result).toContain('"pr_number": 102');
    expect(result).toContain('"prev_pr": 101');
    expect(result).toContain('"next_pr": 103');
  });

  it('handles null prev/next for single-branch stack', () => {
    const result = buildMetadataBlock('uuid-2', 42, null, null, 'feat/solo');

    expect(result).toContain('"prev_pr": null');
    expect(result).toContain('"next_pr": null');
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
});

describe('parseDubstackMetadata', () => {
  it('parses metadata block from a composed PR body', () => {
    const body = composePrBody(
      'My description',
      '',
      'STACK',
      buildMetadataBlock('stack-1', 12, 11, 13, 'feat/a'),
    );

    expect(parseDubstackMetadata(body)).toEqual({
      stack_id: 'stack-1',
      pr_number: 12,
      prev_pr: 11,
      next_pr: 13,
      branch: 'feat/a',
    });
  });

  it('returns null when metadata block is missing', () => {
    expect(parseDubstackMetadata('no metadata here')).toBeNull();
  });

  it('returns null when metadata JSON is invalid', () => {
    const broken = 'text\n<!-- dubstack-metadata\n{ nope }\n-->';
    expect(parseDubstackMetadata(broken)).toBeNull();
  });
});
