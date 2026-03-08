import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import type { FileResolution } from './conflict-ui';
import {
  applyResolution,
  computeDiff,
  renderBatchPreview,
} from './conflict-ui';

const mockExeca = execa as unknown as MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeDiff', () => {
  it('returns empty hunks for identical content', () => {
    const text = 'line1\nline2\nline3';
    expect(computeDiff(text, text)).toEqual([]);
  });

  it('detects added lines', () => {
    const hunks = computeDiff('a\nb', 'a\nb\nc');
    expect(hunks.length).toBe(1);
    const lines = hunks[0].lines;
    expect(lines.some((l) => l === '+c')).toBe(true);
  });

  it('detects removed lines', () => {
    const hunks = computeDiff('a\nb\nc', 'a\nc');
    expect(hunks.length).toBe(1);
    const lines = hunks[0].lines;
    expect(lines.some((l) => l === '-b')).toBe(true);
  });

  it('detects replaced lines', () => {
    const hunks = computeDiff('a\nold\nc', 'a\nnew\nc');
    expect(hunks.length).toBe(1);
    const lines = hunks[0].lines;
    expect(lines.some((l) => l === '-old')).toBe(true);
    expect(lines.some((l) => l === '+new')).toBe(true);
  });

  it('produces context lines around changes', () => {
    const old = 'a\nb\nc\nd\ne\nf\ng';
    const changed = 'a\nb\nc\nX\ne\nf\ng';
    const hunks = computeDiff(old, changed, 2);
    expect(hunks.length).toBe(1);
    // Context lines start with space
    const contextLines = hunks[0].lines.filter((l) => l.startsWith(' '));
    expect(contextLines.length).toBeGreaterThanOrEqual(2);
  });
});

describe('renderBatchPreview', () => {
  it('outputs diff with file headers', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const resolutions: FileResolution[] = [
      {
        path: 'src/foo.ts',
        originalContent: 'line1\nline2',
        resolvedContent: 'line1\nchanged',
        confidence: 'high',
        explanation: 'straightforward fix',
      },
    ];

    renderBatchPreview(resolutions);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('a/src/foo.ts');
    expect(output).toContain('b/src/foo.ts');
    expect(output).toContain('@@');

    logSpy.mockRestore();
  });

  it('shows confidence and explanation', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    renderBatchPreview([
      {
        path: 'x.ts',
        originalContent: 'a',
        resolvedContent: 'b',
        confidence: 'low',
        explanation: 'risky change',
      },
    ]);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('low');
    expect(output).toContain('risky change');

    logSpy.mockRestore();
  });
});

describe('applyResolution', () => {
  it('writes file and runs git add', async () => {
    const dir = await fs.promises.mkdtemp('/tmp/conflict-ui-test-');
    const file = 'test.ts';
    const content = 'resolved content';

    mockExeca.mockResolvedValueOnce({ stdout: '' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await applyResolution(file, content, dir);

    const written = fs.readFileSync(path.join(dir, file), 'utf-8');
    expect(written).toBe(content);

    expect(mockExeca).toHaveBeenCalledWith('git', ['add', file], { cwd: dir });

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Resolved test.ts');

    logSpy.mockRestore();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});

describe('FileResolution type', () => {
  it('accepts valid resolution objects', () => {
    const res: FileResolution = {
      path: 'src/index.ts',
      originalContent: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>>',
      resolvedContent: 'merged',
      confidence: 'medium',
      explanation: 'combined both sides',
    };
    expect(res.confidence).toBe('medium');
    expect(res.path).toBe('src/index.ts');
  });
});
