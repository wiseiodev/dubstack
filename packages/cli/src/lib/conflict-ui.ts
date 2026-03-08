import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import { execa } from 'execa';
import { DubError } from './errors';

export interface FileResolution {
  path: string;
  originalContent: string;
  resolvedContent: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function confidenceColor(level: FileResolution['confidence']): string {
  switch (level) {
    case 'high':
      return chalk.green(level);
    case 'medium':
      return chalk.yellow(level);
    case 'low':
      return chalk.red(level);
  }
}

/**
 * Compute a simple line-by-line diff between two strings.
 * Returns unified-diff style hunks with context lines.
 */
const DIFF_MAX_LINES = 3000;

export function computeDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): DiffHunk[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Guard against OOM on very large files — fall back to full-file diff
  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    return [
      {
        oldStart: 1,
        oldCount: oldLines.length,
        newStart: 1,
        newCount: newLines.length,
        lines: [
          ...oldLines.map((l) => `-${l}`),
          ...newLines.map((l) => `+${l}`),
        ],
      },
    ];
  }

  // Build longest common subsequence table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get edit operations
  type Op = {
    type: 'equal' | 'delete' | 'insert';
    oldIdx: number;
    newIdx: number;
    line: string;
  };
  const ops: Op[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({
        type: 'equal',
        oldIdx: i - 1,
        newIdx: j - 1,
        line: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({
        type: 'insert',
        oldIdx: i - 1,
        newIdx: j - 1,
        line: newLines[j - 1],
      });
      j--;
    } else {
      ops.push({
        type: 'delete',
        oldIdx: i - 1,
        newIdx: -1,
        line: oldLines[i - 1],
      });
      i--;
    }
  }

  ops.reverse();

  // Group into hunks with context
  const changes: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'equal') {
      changes.push(idx);
    }
  }

  if (changes.length === 0) return [];

  // Merge nearby changes into hunk groups
  const groups: number[][] = [];
  let currentGroup = [changes[0]];

  for (let idx = 1; idx < changes.length; idx++) {
    if (changes[idx] - changes[idx - 1] <= contextLines * 2 + 1) {
      currentGroup.push(changes[idx]);
    } else {
      groups.push(currentGroup);
      currentGroup = [changes[idx]];
    }
  }
  groups.push(currentGroup);

  // Build hunks
  const hunks: DiffHunk[] = [];

  for (const group of groups) {
    const start = Math.max(0, group[0] - contextLines);
    const end = Math.min(
      ops.length - 1,
      group[group.length - 1] + contextLines,
    );

    const lines: string[] = [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    let firstLine = true;

    for (let idx = start; idx <= end; idx++) {
      const op = ops[idx];
      if (firstLine) {
        if (op.type === 'equal' || op.type === 'delete') {
          oldStart = op.oldIdx + 1;
        } else {
          // insert — old line position is one past the last old line before this
          oldStart = op.oldIdx + 1 + 1;
        }
        if (op.type === 'equal' || op.type === 'insert') {
          newStart = op.newIdx + 1;
        } else {
          newStart = op.newIdx + 1 + 1;
        }
        firstLine = false;
      }

      switch (op.type) {
        case 'equal':
          lines.push(` ${op.line}`);
          oldCount++;
          newCount++;
          break;
        case 'delete':
          lines.push(`-${op.line}`);
          oldCount++;
          break;
        case 'insert':
          lines.push(`+${op.line}`);
          newCount++;
          break;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}

function formatHunkHeader(hunk: DiffHunk): string {
  return chalk.cyan(
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
  );
}

function colorDiffLine(line: string): string {
  if (line.startsWith('+')) return chalk.green(line);
  if (line.startsWith('-')) return chalk.red(line);
  return chalk.dim(line);
}

export function renderBatchPreview(resolutions: FileResolution[]): void {
  for (const res of resolutions) {
    console.log(chalk.bold(`\n--- a/${res.path}`));
    console.log(chalk.bold(`+++ b/${res.path}`));
    console.log(
      `  confidence: ${confidenceColor(res.confidence)}  ${chalk.dim(res.explanation)}`,
    );

    const hunks = computeDiff(res.originalContent, res.resolvedContent);
    for (const hunk of hunks) {
      console.log(formatHunkHeader(hunk));
      for (const line of hunk.lines) {
        console.log(colorDiffLine(line));
      }
    }
  }
}

async function promptChoice<T extends string>(
  question: string,
  choices: Record<string, T>,
): Promise<T> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim().toLowerCase();
      const match = choices[answer];
      if (match) return match;
      console.log(
        chalk.yellow(
          `Invalid choice. Options: ${[...new Set(Object.keys(choices))].join(', ')}`,
        ),
      );
    }
  } finally {
    rl.close();
  }
}

export async function promptBatchAction(): Promise<
  'apply-all' | 'review' | 'abort'
> {
  return promptChoice('[A]pply All  [R]eview Individually  [C]ancel: ', {
    a: 'apply-all',
    'apply all': 'apply-all',
    r: 'review',
    review: 'review',
    c: 'abort',
    cancel: 'abort',
  });
}

export async function promptFileAction(
  file: string,
): Promise<'apply' | 'skip' | 'abort'> {
  return promptChoice(`${file}: [A]pply  [S]kip  [C]ancel: `, {
    a: 'apply',
    apply: 'apply',
    s: 'skip',
    skip: 'skip',
    c: 'abort',
    cancel: 'abort',
  });
}

export function validateResolutionPaths(
  resolutions: FileResolution[],
  conflictedFiles: string[],
  cwd: string,
): void {
  const allowed = new Set(conflictedFiles);
  const seen = new Set<string>();
  for (const res of resolutions) {
    if (seen.has(res.path)) {
      throw new DubError(`Duplicate resolution path: ${res.path}`);
    }
    seen.add(res.path);
    if (!allowed.has(res.path)) {
      throw new DubError(
        `AI returned path "${res.path}" which is not a conflicted file. Aborting for safety.`,
      );
    }
    const resolved = path.resolve(cwd, res.path);
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      throw new DubError(
        `Path "${res.path}" resolves outside repository. Aborting for safety.`,
      );
    }
  }
}

export async function applyResolution(
  file: string,
  content: string,
  cwd: string,
): Promise<void> {
  const filePath = path.resolve(cwd, file);
  if (!filePath.startsWith(cwd + path.sep)) {
    throw new DubError(`Refusing to write outside repository: ${file}`);
  }

  // Reject symlinks to prevent writes outside the repo
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new DubError(`Refusing to write to symlinked path: ${file}`);
    }
  } catch (err) {
    if (err instanceof DubError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DubError(
        `Conflicted file "${file}" does not exist. Aborting for safety.`,
      );
    }
    throw err;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  await execa('git', ['add', '--', file], { cwd });
  console.log(chalk.green(`✔ Resolved ${file}`));
}

export async function showScopeWarning(warning: string): Promise<boolean> {
  console.log(chalk.yellow(warning));
  const choice = await promptChoice('[C]ontinue  [A]bort: ', {
    c: 'continue',
    continue: 'continue',
    a: 'abort',
    abort: 'abort',
  });
  return choice === 'continue';
}
