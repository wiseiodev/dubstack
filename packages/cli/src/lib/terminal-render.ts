import chalk from 'chalk';

interface WritableLike {
  write: (chunk: string | Uint8Array) => unknown;
  isTTY?: boolean;
}

export interface TerminalRenderer {
  renderMarkdown: (markdown: string) => void;
  renderPreview: (title: string, markdown: string) => void;
  renderStatus: (status: string) => void;
  renderToolActivity: (toolName: string, detail?: string) => void;
}

export function createTerminalRenderer(output: WritableLike): TerminalRenderer {
  const isTTY = output.isTTY === true;

  const writeBlock = (text: string) => {
    if (text.trim().length === 0) return;
    output.write(`${text}\n`);
  };

  return {
    renderMarkdown(markdown: string) {
      writeBlock(formatMarkdown(markdown, { isTTY }));
    },
    renderPreview(title: string, markdown: string) {
      const heading = isTTY ? chalk.bold(title) : title;
      const divider = isTTY
        ? chalk.dim('─'.repeat(title.length))
        : '-'.repeat(title.length);
      const body = formatMarkdown(markdown, { isTTY });
      writeBlock([heading, divider, body].filter(Boolean).join('\n'));
    },
    renderStatus(status: string) {
      const trimmed = status.trim();
      if (trimmed.length === 0) return;
      const line = `AI: ${trimmed}`;
      const styled = isTTY ? chalk.cyan(line) : line;
      writeBlock(styled);
    },
    renderToolActivity(toolName: string, detail?: string) {
      const normalizedTool = toolName.trim() || 'tool';
      const trimmedDetail = detail?.trim();
      const base = `AI: running ${normalizedTool}`;
      const line =
        trimmedDetail && trimmedDetail.length > 0
          ? `${base}  ${trimmedDetail}`
          : base;
      writeBlock(isTTY ? chalk.yellow(line) : line);
    },
  };
}

function formatMarkdown(markdown: string, options: { isTTY: boolean }): string {
  const trimmed = markdown.trimEnd();
  if (trimmed.length === 0) return '';
  if (!options.isTTY) return trimmed;

  const lines = trimmed.split('\n');
  const output: string[] = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      output.push(chalk.cyan(`  ${line}`));
      continue;
    }

    if (isTableLine(trimmedLine)) {
      const tableLines: string[] = [];
      while (index < lines.length && isTableLine(lines[index].trim())) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      index -= 1;
      output.push(...formatTable(tableLines));
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmedLine);
    if (headingMatch) {
      output.push(chalk.bold(headingMatch[2]));
      continue;
    }

    if (trimmedLine.startsWith('>')) {
      output.push(chalk.dim(`│ ${trimmedLine.slice(1).trim()}`));
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function isTableLine(line: string): boolean {
  return line.startsWith('|') && line.endsWith('|');
}

function formatTable(lines: string[]): string[] {
  const rows = lines
    .filter((line) => !/^\|[ \t:-]+(\|[ \t:-]+)+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );

  if (rows.length === 0) return [];

  const widths = rows.reduce<number[]>((current, row) => {
    row.forEach((cell, index) => {
      current[index] = Math.max(current[index] ?? 0, cell.length);
    });
    return current;
  }, []);

  return rows.map((row, index) => {
    const formatted = row
      .map((cell, cellIndex) => cell.padEnd(widths[cellIndex] ?? cell.length))
      .join(' | ');
    if (index === 0) {
      const divider = widths.map((width) => '─'.repeat(width)).join('─┼─');
      return `${chalk.bold(formatted)}\n${chalk.dim(divider)}`;
    }
    return formatted;
  });
}
