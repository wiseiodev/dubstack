import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { readHistory } from '../lib/history';
import { type DubState, initState, writeState } from '../lib/state';

let dir: string;
let cleanup: () => Promise<void>;
let child: ChildProcessWithoutNullStreams | null = null;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await initState(dir);
});

afterEach(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
  child = null;
  await cleanup();
});

describe('mcp command', () => {
  it('lists tools, calls dubstack.log, and audits the invocation', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    const state: DubState = {
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: 12,
              pr_link: 'https://github.com/example/repo/pull/12',
            },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const server = startMcpServer(dir);
    child = server.child;

    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'vitest', version: '0.0.0' },
      },
    });
    const initialized = await server.nextJson();
    const initializedResult = initialized.result as {
      capabilities: { tools: { listChanged: boolean } };
    };
    expect(initializedResult.capabilities.tools).toEqual({
      listChanged: false,
    });

    server.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    server.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const toolsList = await server.nextJson();
    const toolsListResult = toolsList.result as {
      tools: Array<{ name: string }>;
    };
    expect(toolsListResult.tools.map((tool) => tool.name)).toEqual([
      'dubstack.log',
      'dubstack.doctor',
      'dubstack.status',
      'dubstack.parent',
      'dubstack.children',
      'dubstack.trunk',
      'dubstack.history',
    ]);

    server.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'dubstack.log',
        arguments: {},
      },
    });
    const logResponse = await server.nextJson();
    const logResult = logResponse.result as {
      content: Array<{ type: string }>;
      structuredContent: unknown;
    };
    expect(logResult.structuredContent).toMatchObject({
      currentBranch: 'feat/a',
      stacks: [
        {
          id: 'stack-1',
          root: {
            name: 'main',
            type: 'root',
            children: [
              {
                name: 'feat/a',
                type: 'branch',
                current: true,
                prNumber: 12,
              },
            ],
          },
        },
      ],
    });
    expect(logResult.content[0].type).toBe('text');

    const entries = await readHistory(dir, { limit: 5 });
    expect(
      entries.some(
        (entry) => entry.command === 'dub mcp tools/call dubstack.log',
      ),
    ).toBe(true);
  });
});

function startMcpServer(cwd: string): {
  child: ChildProcessWithoutNullStreams;
  send: (message: unknown) => void;
  nextJson: () => Promise<Record<string, unknown>>;
} {
  const tsxBin = fileURLToPath(
    new URL('../../node_modules/.bin/tsx', import.meta.url),
  );
  const indexPath = fileURLToPath(new URL('../index.ts', import.meta.url));
  const process = spawn(tsxBin, [indexPath, 'mcp'], {
    cwd,
    env: {
      ...globalThis.process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffer = '';

  process.stdout.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (!part.trim()) continue;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(part);
      } else {
        lines.push(part);
      }
    }
  });

  return {
    child: process,
    send: (message: unknown) => {
      process.stdin.write(`${JSON.stringify(message)}\n`);
    },
    nextJson: async () => {
      const line =
        lines.shift() ??
        (await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for MCP response.'));
          }, 5000);
          waiters.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        }));
      return JSON.parse(line) as Record<string, unknown>;
    },
  };
}
