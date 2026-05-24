import { describe, expect, it } from 'vitest';
import { parseAiSplitResponse, parseIndexSelection } from './split';

describe('parseAiSplitResponse', () => {
  it('accepts a valid response and normalizes branch names', async () => {
    const text = JSON.stringify({
      splits: [
        { branch: 'Feat/Runtime', files: ['runtime.ts'], summary: 'rt' },
        { branch: 'docs/notes', files: ['docs.md'], summary: 'd' },
      ],
    });
    const out = parseAiSplitResponse(text, ['runtime.ts', 'docs.md']);
    expect(out).toEqual([
      { branch: 'feat/runtime', files: ['runtime.ts'], summary: 'rt' },
      { branch: 'docs/notes', files: ['docs.md'], summary: 'd' },
    ]);
  });

  it('strips markdown fences', async () => {
    const text =
      '```json\n' +
      JSON.stringify({
        splits: [{ branch: 'feat/x', files: ['x.ts'], summary: '' }],
      }) +
      '\n```';
    const out = parseAiSplitResponse(text, ['x.ts']);
    expect(out[0].branch).toBe('feat/x');
  });

  it('rejects duplicate files across splits', () => {
    const text = JSON.stringify({
      splits: [
        { branch: 'a', files: ['x.ts'], summary: '' },
        { branch: 'b', files: ['x.ts'], summary: '' },
      ],
    });
    expect(() => parseAiSplitResponse(text, ['x.ts'])).toThrow('duplicated');
  });

  it('rejects unknown files', () => {
    const text = JSON.stringify({
      splits: [{ branch: 'a', files: ['not-here.ts'], summary: '' }],
    });
    expect(() => parseAiSplitResponse(text, ['x.ts'])).toThrow('unknown file');
  });

  it('rejects empty splits array', () => {
    expect(() =>
      parseAiSplitResponse(JSON.stringify({ splits: [] }), ['x.ts']),
    ).toThrow('no split proposals');
  });

  it('rejects splits with no files', () => {
    const text = JSON.stringify({
      splits: [{ branch: 'a', files: [], summary: '' }],
    });
    expect(() => parseAiSplitResponse(text, ['x.ts'])).toThrow('no files');
  });
});

describe('parseIndexSelection', () => {
  it('handles space-separated indices', () => {
    expect(parseIndexSelection('1 3 5', 5)).toEqual([0, 2, 4]);
  });

  it('handles comma-separated indices', () => {
    expect(parseIndexSelection('1,2,4', 5)).toEqual([0, 1, 3]);
  });

  it('handles ranges and mixes', () => {
    expect(parseIndexSelection('1-3,5', 5)).toEqual([0, 1, 2, 4]);
  });

  it('dedupes', () => {
    expect(parseIndexSelection('1 1 2 1', 5)).toEqual([0, 1]);
  });

  it('rejects out-of-range', () => {
    expect(() => parseIndexSelection('1 9', 5)).toThrow('Invalid commit');
  });

  it('rejects malformed ranges', () => {
    expect(() => parseIndexSelection('3-1', 5)).toThrow('Invalid commit range');
  });

  it('returns empty array on empty input', () => {
    expect(parseIndexSelection('', 5)).toEqual([]);
  });
});
