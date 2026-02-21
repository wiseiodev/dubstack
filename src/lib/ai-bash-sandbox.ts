import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandResult, Sandbox } from 'bash-tool';
import { execa } from 'execa';

const COMMAND_TIMEOUT_MS = 60_000;
const SAFE_COMMANDS = new Set([
  'pwd',
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'sed',
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'branch',
  'log',
  'show',
  'diff',
  'rev-parse',
  'symbolic-ref',
  'for-each-ref',
  'remote',
]);
const SAFE_DUB_SUBCOMMANDS = new Set(['doctor', 'ready', 'log', 'history']);
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\b/, reason: 'file deletion command family (rm -rf)' },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: 'destructive git history reset (git reset --hard)',
  },
  {
    pattern: /\bgit\s+clean\s+-fd/,
    reason: 'destructive untracked file cleanup (git clean -fd)',
  },
  { pattern: /\bmkfs\b/, reason: 'filesystem formatting command (mkfs)' },
  { pattern: /\bshutdown\b/, reason: 'system shutdown command (shutdown)' },
  { pattern: /\breboot\b/, reason: 'system reboot command (reboot)' },
  { pattern: /:\(\)\{:\|:&\};:/, reason: 'fork bomb pattern' },
];

export function createLocalBashSandbox(cwd: string): Sandbox {
  const root = path.resolve(cwd);

  return {
    async executeCommand(command) {
      const policyViolation = validateCommandPolicy(command);
      if (policyViolation) {
        return blockedResult(policyViolation);
      }

      try {
        const { stdout, stderr, exitCode } = await execa(
          'bash',
          ['-lc', command],
          {
            cwd: root,
            reject: false,
            timeout: COMMAND_TIMEOUT_MS,
            env: {
              ...process.env,
              CI: process.env.CI ?? '1',
              GIT_TERMINAL_PROMPT: '0',
            },
          },
        );

        return {
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
        };
      } catch (error) {
        const execaError = error as
          | {
              message?: string;
              shortMessage?: string;
              timedOut?: boolean;
            }
          | undefined;
        const timedOut = Boolean(execaError?.timedOut);
        const message =
          execaError?.shortMessage ??
          execaError?.message ??
          'Failed to execute command';

        return {
          stdout: '',
          stderr: timedOut
            ? `Command execution timed out after ${COMMAND_TIMEOUT_MS}ms: ${message}`
            : `Command execution failed: ${message}`,
          exitCode: timedOut ? 124 : 1,
        };
      }
    },

    async readFile(filePath) {
      const resolvedPath = resolveWithinRoot(root, filePath);
      return fs.readFile(resolvedPath, 'utf8');
    },

    async writeFiles(files) {
      for (const file of files) {
        const resolvedPath = resolveWithinRoot(root, file.path);
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, file.content);
      }
    },
  };
}

function resolveWithinRoot(root: string, inputPath: string): string {
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path is outside the repository sandbox: ${inputPath}`);
  }

  return resolved;
}

function validateCommandPolicy(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return 'Empty commands are not allowed.';
  }

  const disallowedOperator = findDisallowedShellOperator(trimmed);
  if (disallowedOperator) {
    return `Shell operator '${disallowedOperator}' is not allowed in this sandbox.`;
  }

  const blockedPattern = findBlockedPattern(trimmed);
  if (blockedPattern) {
    return `Blocked command pattern detected: ${blockedPattern.reason}.`;
  }

  if (!isAllowlistedCommand(trimmed)) {
    return "Only read-only allow-listed commands are supported: pwd, ls, find, cat, head, tail, wc, grep, rg, sed, 'git status|branch|log|show|diff|rev-parse|symbolic-ref|for-each-ref|remote', and 'dub doctor|ready|log|history'.";
  }

  return null;
}

function findDisallowedShellOperator(command: string): string | null {
  if (command.includes('&&')) return '&&';
  if (command.includes('||')) return '||';
  if (command.includes('`')) return '`';
  if (command.includes('$(')) return '$(';
  if (command.includes(';')) return ';';
  if (command.includes('|')) return '|';
  if (command.includes('>')) return '>';
  if (command.includes('<')) return '<';
  if (command.includes('\n') || command.includes('\r')) return 'newline';
  return null;
}

function isAllowlistedCommand(command: string): boolean {
  const [executable, subcommand] = command.split(/\s+/, 3);
  if (!executable) return false;
  if (SAFE_COMMANDS.has(executable)) return true;
  if (executable === 'git') {
    return Boolean(subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand));
  }
  if (executable === 'dub') {
    return Boolean(subcommand && SAFE_DUB_SUBCOMMANDS.has(subcommand));
  }
  return false;
}

function findBlockedPattern(command: string): { reason: string } | null {
  for (const entry of BLOCKED_PATTERNS) {
    if (entry.pattern.test(command)) {
      return entry;
    }
  }
  return null;
}

function blockedResult(reason: string): CommandResult {
  return {
    stdout: '',
    stderr: `Command blocked for safety by DubStack assistant policy: ${reason}`,
    exitCode: 2,
  };
}
