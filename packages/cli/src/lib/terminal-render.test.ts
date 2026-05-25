import { describe, expect, it } from 'vitest';
import { createTerminalRenderer } from './terminal-render';

function createCapture(isTTY: boolean) {
  const writes: string[] = [];
  return {
    writes,
    output: {
      isTTY,
      write(value: string | Uint8Array) {
        writes.push(typeof value === 'string' ? value : value.toString());
        return true;
      },
    },
  };
}

describe('createTerminalRenderer', () => {
  it('renders markdown headings, quotes, code fences, and tables in TTY mode', () => {
    const capture = createCapture(true);
    const renderer = createTerminalRenderer(capture.output);

    renderer.renderMarkdown(
      [
        '# Summary',
        '',
        '> quoted context',
        '',
        '```ts',
        'const value = 1;',
        '```',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| foo | 1 |',
      ].join('\n'),
    );

    const rendered = capture.writes.join('');
    expect(rendered).toContain('Summary');
    expect(rendered).not.toContain('# Summary');
    expect(rendered).toContain('│ quoted context');
    expect(rendered).not.toContain('```');
    expect(rendered).toContain('const value = 1;');
    expect(rendered).toContain('Name');
    expect(rendered).toContain('foo');
  });

  it('keeps markdown plain in non-tty mode', () => {
    const capture = createCapture(false);
    const renderer = createTerminalRenderer(capture.output);

    renderer.renderMarkdown('# Summary\n\n- item');

    expect(capture.writes.join('')).toBe('# Summary\n\n- item\n');
  });

  it('strips markdown table separator rows and resists pathological inputs', () => {
    const capture = createCapture(true);
    const renderer = createTerminalRenderer(capture.output);

    renderer.renderMarkdown(
      ['| Name | Value |', '| :--- | ---: |', '| foo | 1 |'].join('\n'),
    );
    const rendered = capture.writes.join('');
    expect(rendered).not.toContain(':---');
    expect(rendered).not.toContain('---:');

    const pathological = `| |${'  |'.repeat(26)}x|`;
    const start = performance.now();
    const capture2 = createCapture(true);
    createTerminalRenderer(capture2.output).renderMarkdown(pathological);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('renders preview panels and tool activity lines', () => {
    const capture = createCapture(true);
    const renderer = createTerminalRenderer(capture.output);

    renderer.renderPreview('PR Description', '## Changes\n\n- add AI summary');
    renderer.renderToolActivity('bash', 'git status --short');

    const rendered = capture.writes.join('');
    expect(rendered).toContain('PR Description');
    expect(rendered).toContain('Changes');
    expect(rendered).toContain('AI: running bash');
    expect(rendered).toContain('git status --short');
  });
});
