import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getCurrentBranch } from '../lib/git';
import { readHistory } from '../lib/history';
import { type DubState, initState, writeState } from '../lib/state';
import { configMcpMode } from './config';
import { type ConfirmMutatingFn, mcp } from './mcp';

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
  if (child) {
    await stopMcpChild(child);
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
      'dubstack.create',
      'dubstack.modify',
      'dubstack.submit',
      'dubstack.sync',
      'dubstack.checkout',
      'dubstack.absorb',
      'dubstack.delete',
      'dubstack.stash',
      'dubstack.stash-pop',
      'dubstack.stash-list',
    ]);

    server.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'dubstack.log',
        arguments: {
          stack: true,
          ignored: 'x'.repeat(1000),
        },
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
        (entry) =>
          entry.command === 'dub mcp tools/call dubstack.log {"stack":true}',
      ),
    ).toBe(true);

    await stopMcpChild(server.child);
    child = null;

    const postShutdownEntries = await readHistory(dir, { limit: 5 });
    expect(
      postShutdownEntries.some((entry) => entry.command === 'dub mcp'),
    ).toBe(false);
  });
});

describe('mcp mutating tools', () => {
  it('refuses dubstack.create in read-only mode and audits the refusal', async () => {
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
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);
    await configMcpMode(dir, 'read-only');

    const confirm = vi.fn<ConfirmMutatingFn>();
    const response = await runMcpCall(dir, confirm, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'dubstack.create',
        arguments: { name: 'feat/b' },
      },
    });

    const result = response.result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'dubstack.create refused: repo is in read-only MCP mode. Run `dub config mcp-mode interactive` to enable mutating tools.',
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(await getCurrentBranch(dir)).toBe('feat/a');

    const entries = await readHistory(dir, { limit: 5 });
    expect(
      entries.some(
        (entry) =>
          entry.status === 'error' &&
          entry.command.startsWith('dub mcp tools/call dubstack.create'),
      ),
    ).toBe(true);
  });

  it('runs dubstack.checkout in trusted mode without confirmation', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat a']);
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
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);
    await configMcpMode(dir, 'trusted');

    const confirm = vi.fn<ConfirmMutatingFn>();
    const response = await runMcpCall(dir, confirm, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'dubstack.checkout',
        arguments: { branch: 'main' },
      },
    });

    const result = response.result as {
      isError?: boolean;
      structuredContent: { result: { branch: string } };
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.result.branch).toBe('main');
    expect(confirm).not.toHaveBeenCalled();
    expect(await getCurrentBranch(dir)).toBe('main');
  });

  it('runs dubstack.checkout in interactive mode only after confirmation', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat a']);
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
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);
    await configMcpMode(dir, 'interactive');

    const confirm = vi
      .fn<ConfirmMutatingFn>()
      .mockResolvedValue({ confirmed: true, reason: 'ok' });
    const response = await runMcpCall(dir, confirm, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'dubstack.checkout',
        arguments: { branch: 'main' },
      },
    });

    const result = response.result as {
      isError?: boolean;
      structuredContent: { result: { branch: string } };
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.result.branch).toBe('main');
    expect(confirm).toHaveBeenCalledWith('dubstack.checkout', {
      branch: 'main',
    });
    expect(await getCurrentBranch(dir)).toBe('main');
  });

  it('refuses in interactive mode when the user declines', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat a']);
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
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);
    await configMcpMode(dir, 'interactive');

    const confirm = vi
      .fn<ConfirmMutatingFn>()
      .mockResolvedValue({ confirmed: false, reason: 'declined' });
    const response = await runMcpCall(dir, confirm, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'dubstack.checkout',
        arguments: { branch: 'main' },
      },
    });

    const result = response.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('declined');
    expect(await getCurrentBranch(dir)).toBe('feat/a');
  });
});

async function runMcpCall(
  cwd: string,
  confirmMutating: ConfirmMutatingFn,
  message: unknown,
): Promise<Record<string, unknown>> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');

  const responses: Record<string, unknown>[] = [];
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim()) {
        responses.push(JSON.parse(part) as Record<string, unknown>);
      }
    }
  });

  const done = mcp(cwd, { input, output, confirmMutating });

  input.write(`${JSON.stringify(message)}\n`);
  input.end();
  await done;

  if (responses.length === 0) {
    throw new Error('No MCP response received.');
  }
  return responses[responses.length - 1];
}

async function stopMcpChild(
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve) => {
    process.once('close', () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve();
    });
  });
  const timedOut = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), 1000);
  });

  process.kill('SIGTERM');
  if ((await Promise.race([closed, timedOut])) === 'timeout') {
    process.kill('SIGKILL');
    await closed;
  }
}

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
