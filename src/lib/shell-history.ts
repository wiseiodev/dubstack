import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactSensitiveText } from './history';

export interface ReadRecentShellHistoryOptions {
  homeDir?: string;
  shell?: string;
  maxCommands?: number;
}

export async function readRecentShellHistory(
  options: ReadRecentShellHistoryOptions = {},
): Promise<string[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const shell = options.shell ?? process.env.SHELL ?? '';
  const maxCommands = options.maxCommands ?? 200;
  if (maxCommands <= 0) return [];

  const files = getCandidateHistoryFiles(homeDir, shell);
  const collected: string[] = [];
  for (const file of files) {
    const parsed = await readHistoryFile(file);
    collected.push(...parsed);
  }

  return collected
    .slice(-maxCommands)
    .map((line) => redactSensitiveText(line))
    .filter((line) => line.trim().length > 0);
}

function getCandidateHistoryFiles(homeDir: string, shell: string): string[] {
  const normalized = shell.toLowerCase();
  if (normalized.includes('zsh')) {
    return [path.join(homeDir, '.zsh_history')];
  }
  if (normalized.includes('bash')) {
    return [path.join(homeDir, '.bash_history')];
  }
  return [path.join(homeDir, '.zsh_history'), path.join(homeDir, '.bash_history')];
}

async function readHistoryFile(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map(parseHistoryLine)
      .filter((line): line is string => line !== null);
  } catch {
    return [];
  }
}

function parseHistoryLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const zshMatch = trimmed.match(/^:\s+\d+:\d+;(.*)$/);
  if (zshMatch) {
    return zshMatch[1].trim();
  }
  return trimmed;
}
