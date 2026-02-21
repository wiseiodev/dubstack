import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Sandbox } from 'bash-tool';
import { execa } from 'execa';

const COMMAND_TIMEOUT_MS = 60_000;
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /:\(\)\{:\|:&\};:/,
];

export function createLocalBashSandbox(cwd: string): Sandbox {
  const root = path.resolve(cwd);

  return {
    async executeCommand(command) {
      const blockedPattern = findBlockedPattern(command);
      if (blockedPattern) {
        return {
          stdout: '',
          stderr: `Command blocked for safety by DubStack assistant policy: ${blockedPattern}`,
          exitCode: 2,
        };
      }

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

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the repository sandbox: ${inputPath}`);
  }

  return resolved;
}

function findBlockedPattern(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.source;
    }
  }
  return null;
}
