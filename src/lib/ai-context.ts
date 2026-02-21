import { execa } from 'execa';
import { doctor } from '../commands/doctor';
import { getCurrentBranch } from './git';
import { readHistory } from './history';
import { detectActiveOperation } from './operation-state';
import { type Branch, findStackForBranch, readState } from './state';

export interface AiContext {
  generatedAt: string;
  currentBranch: string | null;
  activeOperation: string | null;
  gitStatusShort: string[];
  stack: {
    trunk: string;
    parent: string | null;
    children: string[];
    pathToCurrent: string[];
  } | null;
  doctor: {
    healthy: boolean;
    issues: Array<{
      code: string;
      summary: string;
      fixes: string[];
    }>;
  } | null;
  recentHistory: Array<{
    timestamp: string;
    command: string;
    status: 'success' | 'error';
    durationMs: number;
    output: string[];
    errorMessage?: string;
  }>;
}

export async function collectAiContext(cwd: string): Promise<AiContext> {
  const currentBranch = await getCurrentBranch(cwd).catch(() => null);
  const activeOperation = await detectActiveOperation(cwd).catch(() => null);
  const gitStatusShort = await readGitStatusShort(cwd).catch(() => []);
  const stack = await readStackContext(cwd, currentBranch).catch(() => null);
  const doctorResult = await doctor(cwd, { all: false, fetch: false }).catch(
    () => null,
  );
  const recentHistory = (await readHistory(cwd, { limit: 20 }).catch(() => []))
    .reverse()
    .map((entry) => ({
      timestamp: entry.timestamp,
      command: entry.command,
      status: entry.status,
      durationMs: entry.durationMs,
      output: entry.output.slice(-6).map((line) => truncate(line, 220)),
      errorMessage: entry.errorMessage,
    }));

  return {
    generatedAt: new Date().toISOString(),
    currentBranch,
    activeOperation,
    gitStatusShort,
    stack,
    doctor: doctorResult
      ? {
          healthy: doctorResult.healthy,
          issues: doctorResult.issues.map((issue) => ({
            code: issue.code,
            summary: issue.summary,
            fixes: issue.fixes,
          })),
        }
      : null,
    recentHistory,
  };
}

export function buildAiSystemPrompt(): string {
  return [
    'You are the DubStack assistant for a local git-stack CLI.',
    'Prioritize safe, concrete, minimal-step guidance.',
    'When command output is needed, use the available bash tool to inspect the repository directly.',
    'Ask for explicit user confirmation before mutating git history, deleting files, or making other destructive changes.',
    "When recovery is needed, prefer DubStack commands like 'dub doctor', 'dub ready', 'dub continue', 'dub abort', 'dub sync', 'dub restack', and 'dub undo'.",
    'Use the provided context packet as the source of truth and call out uncertainty if context is incomplete.',
    'Never invent branch names, command output, or repo state not present in context.',
    'When suggesting commands, provide them in runnable order.',
  ].join(' ');
}

export function buildAiUserPrompt(
  userPrompt: string,
  context: AiContext,
): string {
  return [
    'Use this repository context when answering.',
    'CONTEXT_START',
    JSON.stringify(context, null, 2),
    'CONTEXT_END',
    '',
    'USER_PROMPT',
    userPrompt,
  ].join('\n');
}

async function readGitStatusShort(cwd: string): Promise<string[]> {
  const { stdout } = await execa('git', ['status', '--short', '--branch'], {
    cwd,
  });
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 80);
}

async function readStackContext(
  cwd: string,
  currentBranch: string | null,
): Promise<AiContext['stack']> {
  if (!currentBranch) return null;

  const state = await readState(cwd);
  const stack = findStackForBranch(state, currentBranch);
  if (!stack) return null;

  const current = stack.branches.find(
    (branch) => branch.name === currentBranch,
  );
  const root = stack.branches.find((branch) => branch.type === 'root');
  if (!current || !root) return null;

  const children = stack.branches
    .filter((branch) => branch.parent === currentBranch)
    .map((branch) => branch.name)
    .sort();

  const pathToCurrent: string[] = [];
  let cursor: Branch | undefined = current;
  while (cursor) {
    pathToCurrent.unshift(cursor.name);
    const parentName: string | null = cursor.parent;
    if (!parentName) break;
    cursor = stack.branches.find((branch) => branch.name === parentName);
  }

  return {
    trunk: root.name,
    parent: current.parent,
    children,
    pathToCurrent,
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}
