import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempMarkdownFile } from './temp-text-file';

describe('withTempMarkdownFile', () => {
  it('writes markdown content to a temp file for the callback', async () => {
    let capturedPath = '';

    const result = await withTempMarkdownFile(
      'preview',
      '# Heading\n\nBody\n',
      async (filePath) => {
        capturedPath = filePath;
        expect(filePath.endsWith('.md')).toBe(true);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('# Heading\n\nBody\n');
        return 'done';
      },
    );

    expect(result).toBe('done');
    expect(fs.existsSync(capturedPath)).toBe(false);
  });

  it('cleans up the temp file when the callback throws', async () => {
    let capturedPath = '';

    await expect(
      withTempMarkdownFile('preview', 'Body\n', async (filePath) => {
        capturedPath = filePath;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(fs.existsSync(capturedPath)).toBe(false);
  });
});
