import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { type McpMode, readConfig } from '../lib/config';
import { DubError, formatDubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { appendHistoryEntry, redactSensitiveText } from '../lib/history';
import { detectActiveOperation } from '../lib/operation-state';
import { checkout } from './checkout';
import { children } from './children';
import { create } from './create';
import { deleteCommand } from './delete';
import { doctor } from './doctor';
import { history } from './history';
import { logJson } from './log';
import { modify } from './modify';
import { parent } from './parent';
import { status } from './status';
import { submit } from './submit';
import { sync } from './sync';
import { trunk } from './trunk';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface ConfirmationResult {
  confirmed: boolean;
  reason: string;
}

export type ConfirmMutatingFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ConfirmationResult>;

interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  version?: string;
  confirmMutating?: ConfirmMutatingFn;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
  mutating?: boolean;
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: JsonValue;
  isError?: boolean;
}

const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18']);
const MAX_HISTORY_ARGS_LENGTH = 500;

const HISTORY_ARG_KEYS: Record<string, string[]> = {
  'dubstack.log': ['stack', 'all', 'reverse'],
  'dubstack.doctor': ['all', 'fetch'],
  'dubstack.status': [],
  'dubstack.parent': ['branch'],
  'dubstack.children': ['branch'],
  'dubstack.trunk': ['branch'],
  'dubstack.history': ['limit'],
  'dubstack.create': ['name', 'message', 'ai'],
  'dubstack.modify': ['message', 'commit', 'all'],
  'dubstack.submit': [
    'dryRun',
    'upstack',
    'downstack',
    'stack',
    'branch',
    'path',
    'fix',
  ],
  'dubstack.sync': ['force', 'all'],
  'dubstack.checkout': ['branch'],
  'dubstack.delete': ['branch', 'upstack', 'downstack', 'force'],
};

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} satisfies JsonValue;

const BRANCH_SCHEMA = {
  type: 'object',
  properties: {
    branch: {
      type: 'string',
      description: 'Branch to inspect. Defaults to the current branch.',
    },
  },
  additionalProperties: false,
} satisfies JsonValue;

const TOOLS: ToolDefinition[] = [
  {
    name: 'dubstack.log',
    description: 'Return the tracked DubStack stack tree as structured JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        stack: {
          type: 'boolean',
          description: 'Only include the current tracked stack.',
        },
        all: {
          type: 'boolean',
          description: 'Include all tracked stacks.',
        },
        reverse: {
          type: 'boolean',
          description: 'Reverse stack and child ordering.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.doctor',
    description: 'Return DubStack health issues and remediation steps.',
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Check all stacks instead of only the current stack.',
        },
        fetch: {
          type: 'boolean',
          description: 'Refresh remote refs before remote drift checks.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.status',
    description: 'Return current branch, tracking, PR state, and drift issues.',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'dubstack.parent',
    description: 'Return the direct parent for a tracked branch.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.children',
    description: 'Return direct children for a tracked branch.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.trunk',
    description: 'Return the trunk/root branch for a tracked branch.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.history',
    description: 'Return recent Dub command history.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of history entries to return.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.create',
    description:
      'Create a new branch stacked on top of the current branch, optionally with a commit message.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the new branch (omit when using ai).',
        },
        message: {
          type: 'string',
          description: 'Commit message for staged changes on the new branch.',
        },
        ai: {
          type: 'boolean',
          description:
            'AI-generate the branch name and commit from staged changes.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.modify',
    description:
      'Amend the current branch tip or create a new commit and restack children.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'New commit message (used for amend or new commit).',
        },
        commit: {
          type: 'boolean',
          description:
            'Create a new commit instead of amending the current tip.',
        },
        all: {
          type: 'boolean',
          description: 'Stage all changes before committing.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.submit',
    description:
      'Push branches in the chosen scope and create or update GitHub PRs.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview what would happen without pushing or mutating PRs.',
        },
        upstack: {
          type: 'boolean',
          description: 'Submit current branch and all descendants.',
        },
        downstack: {
          type: 'boolean',
          description:
            'Submit current branch and ancestors to trunk (the default).',
        },
        stack: {
          type: 'boolean',
          description: 'Submit the full tree from trunk.',
        },
        branch: {
          type: 'string',
          description: 'Submit only the specified branch.',
        },
        path: {
          type: 'string',
          enum: ['current', 'stack'],
          description:
            "[deprecated] Use 'downstack' (replaces 'current') or 'stack'.",
        },
        fix: {
          type: 'boolean',
          description: '[deprecated] No-op alias retained for compatibility.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.sync',
    description:
      'Sync tracked branches with the remote, restack, and prune merged branches.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'Skip reset/reconcile prompts and accept deterministic defaults.',
        },
        all: {
          type: 'boolean',
          description: 'Sync all tracked stacks across trunks.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.checkout',
    description: 'Switch to a tracked branch (stack-aware).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to checkout.',
        },
      },
      required: ['branch'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.delete',
    description:
      'Delete a local branch and update DubStack metadata (stack-aware).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to delete (defaults to current branch).',
        },
        upstack: {
          type: 'boolean',
          description: 'Also delete descendants of the target branch.',
        },
        downstack: {
          type: 'boolean',
          description: 'Also delete ancestors toward trunk.',
        },
        force: {
          type: 'boolean',
          description: 'Delete branches even when not fully merged.',
        },
      },
      additionalProperties: false,
    },
  },
];

export async function mcp(
  cwd: string,
  options: McpServerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const serverVersion = options.version ?? '0.0.0';
  const confirmMutating = options.confirmMutating ?? confirmMutatingTool;
  let buffer = '';
  let queue: Promise<void> = Promise.resolve();

  input.setEncoding('utf8');

  await new Promise<void>((resolve) => {
    const enqueue = (line: string) => {
      queue = queue
        .catch(() => undefined)
        .then(() =>
          handleLineSafely(line, cwd, output, serverVersion, confirmMutating),
        );
    };

    input.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        enqueue(line);
      }
    });

    input.on('end', () => {
      if (buffer.trim().length > 0) {
        enqueue(buffer);
      }
      void queue.then(resolve, resolve);
    });
  });
}

async function handleLineSafely(
  line: string,
  cwd: string,
  output: Writable,
  serverVersion: string,
  confirmMutating: ConfirmMutatingFn,
): Promise<void> {
  try {
    await handleLine(line, cwd, output, serverVersion, confirmMutating);
  } catch (error) {
    const requestId = parseRequestId(line);
    const message = error instanceof Error ? error.message : String(error);
    safeWriteMessage(
      output,
      jsonRpcError(requestId, -32603, `Internal error: ${message}`),
    );
  }
}

async function handleLine(
  line: string,
  cwd: string,
  output: Writable,
  serverVersion: string,
  confirmMutating: ConfirmMutatingFn,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    writeMessage(output, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  if (!isJsonRpcRequest(message)) {
    writeMessage(output, jsonRpcError(null, -32600, 'Invalid Request'));
    return;
  }

  if (message.id === undefined) {
    await handleNotification(message);
    return;
  }

  const response = await handleRequest(
    message,
    cwd,
    serverVersion,
    confirmMutating,
  );
  writeMessage(output, response);
}

async function handleNotification(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'notifications/initialized') {
    return;
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  cwd: string,
  serverVersion: string,
  confirmMutating: ConfirmMutatingFn,
): Promise<JsonValue> {
  switch (request.method) {
    case 'initialize':
      return jsonRpcResult(
        request.id ?? null,
        initializeResult(request, serverVersion),
      );
    case 'ping':
      return jsonRpcResult(request.id ?? null, {});
    case 'tools/list':
      return jsonRpcResult(request.id ?? null, { tools: TOOLS });
    case 'tools/call':
      return handleToolCallRequest(request, cwd, confirmMutating);
    default:
      return jsonRpcError(
        request.id ?? null,
        -32601,
        `Method not found: ${request.method}`,
      );
  }
}

async function handleToolCallRequest(
  request: JsonRpcRequest,
  cwd: string,
  confirmMutating: ConfirmMutatingFn,
): Promise<JsonValue> {
  const params = asRecord(request.params);
  const name = typeof params?.name === 'string' ? params.name : null;
  const args = asRecord(params?.arguments) ?? {};

  if (!name) {
    return jsonRpcError(request.id ?? null, -32602, 'Missing tool name.');
  }

  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    await appendMcpHistory(cwd, name, args, Date.now(), 'error', [
      `Unknown MCP tool '${name}'.`,
    ]);
    return jsonRpcError(request.id ?? null, -32602, `Unknown tool: ${name}`);
  }

  const startedAt = Date.now();

  if (tool.mutating) {
    const mode = await resolveMcpMode(cwd);

    if (mode === 'read-only') {
      const text = `${name} refused: repo is in read-only MCP mode. Run \`dub config mcp-mode interactive\` to enable mutating tools.`;
      await appendMcpHistory(cwd, name, args, startedAt, 'error', [text]);
      return jsonRpcResult(request.id ?? null, {
        content: [{ type: 'text', text }],
        isError: true,
      });
    }

    if (mode === 'interactive') {
      const confirmation = await confirmMutating(name, args);
      if (!confirmation.confirmed) {
        await appendMcpHistory(cwd, name, args, startedAt, 'error', [
          confirmation.reason,
        ]);
        return jsonRpcResult(request.id ?? null, {
          content: [{ type: 'text', text: confirmation.reason }],
          isError: true,
        });
      }
    }
  }

  try {
    const result = await callTool(cwd, name, args);
    await appendMcpHistory(cwd, name, args, startedAt, 'success', [
      `MCP tool '${name}' returned structured JSON.`,
    ]);
    return jsonRpcResult(request.id ?? null, result);
  } catch (error) {
    const message =
      error instanceof DubError
        ? formatDubError(error)
        : error instanceof Error
          ? error.message
          : String(error);
    await appendMcpHistory(cwd, name, args, startedAt, 'error', [message]);
    return jsonRpcResult(request.id ?? null, {
      content: [{ type: 'text', text: message }],
      isError: true,
    });
  }
}

async function resolveMcpMode(cwd: string): Promise<McpMode> {
  try {
    const config = await readConfig(cwd);
    return config.mcpMode;
  } catch {
    return 'interactive';
  }
}

async function confirmMutatingTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ConfirmationResult> {
  let fd: number;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
  } catch {
    return {
      confirmed: false,
      reason: `${name} refused: no controlling terminal available for interactive confirmation. Run \`dub config mcp-mode trusted\` to skip prompts, or \`dub config mcp-mode read-only\` to disable mutating tools.`,
    };
  }

  const input = fs.createReadStream('', { fd, autoClose: false });
  const output = fs.createWriteStream('', { fd, autoClose: false });
  const rl = readline.createInterface({ input, output });

  try {
    const summary = formatArgsForPrompt(args);
    const prompt = summary
      ? `\n[dub mcp] Allow ${name} ${summary}? [y/N] `
      : `\n[dub mcp] Allow ${name}? [y/N] `;
    const answer = await rl.question(prompt);
    const normalized = answer.trim().toLowerCase();
    const confirmed = normalized === 'y' || normalized === 'yes';
    return {
      confirmed,
      reason: confirmed
        ? `${name} confirmed by user.`
        : `${name} refused: user declined interactive confirmation.`,
    };
  } finally {
    rl.close();
    // Destroy the streams to release their internal buffers and listeners;
    // autoClose: false means destroy() leaves the underlying fd open for us
    // to close explicitly below.
    input.destroy();
    output.destroy();
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors; the descriptor may already be closed by readline.
    }
  }
}

function formatArgsForPrompt(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const parts = keys.map((key) => `${key}=${JSON.stringify(args[key])}`);
  return `(${parts.join(', ')})`;
}

async function callTool(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (name) {
    case 'dubstack.log':
      return jsonToolResult(
        await logJson(cwd, {
          stack: optionalBoolean(args.stack),
          all: optionalBoolean(args.all),
          reverse: optionalBoolean(args.reverse),
        }),
      );
    case 'dubstack.doctor':
      return jsonToolResult(
        await doctor(cwd, {
          all: optionalBoolean(args.all),
          fetch: optionalBoolean(args.fetch),
        }),
      );
    case 'dubstack.status':
      return jsonToolResult(await status(cwd));
    case 'dubstack.parent':
      return jsonToolResult(await parent(cwd, optionalString(args.branch)));
    case 'dubstack.children':
      return jsonToolResult(await children(cwd, optionalString(args.branch)));
    case 'dubstack.trunk':
      return jsonToolResult(await trunk(cwd, optionalString(args.branch)));
    case 'dubstack.history':
      return jsonToolResult(
        await history(cwd, {
          limit: optionalPositiveInteger(args.limit) ?? 20,
        }),
      );
    case 'dubstack.create':
      return mutatingToolResult(() =>
        create(optionalString(args.name), cwd, {
          message: optionalString(args.message),
          ai: optionalBoolean(args.ai),
        }),
      );
    case 'dubstack.modify':
      return mutatingToolResult(async () => {
        await modify(cwd, {
          message: optionalString(args.message),
          commit: optionalBoolean(args.commit),
          all: optionalBoolean(args.all),
        });
        return { ok: true };
      });
    case 'dubstack.submit':
      return mutatingToolResult(() =>
        submit(cwd, optionalBoolean(args.dryRun) ?? false, {
          upstack: optionalBoolean(args.upstack),
          downstack: optionalBoolean(args.downstack),
          stack: optionalBoolean(args.stack),
          branch: optionalString(args.branch),
          path: optionalSubmitPath(args.path),
          fix: optionalBoolean(args.fix) ?? false,
        }),
      );
    case 'dubstack.sync':
      return mutatingToolResult(() =>
        sync(cwd, {
          force: optionalBoolean(args.force),
          all: optionalBoolean(args.all),
          interactive: false,
        }),
      );
    case 'dubstack.checkout': {
      const branch = optionalString(args.branch);
      if (!branch) {
        throw new DubError("'branch' is required for dubstack.checkout.", [
          "Pass {'branch': '<name>'} in the tool arguments.",
          'Call dubstack.list-stacks to discover tracked branch names.',
        ]);
      }
      return mutatingToolResult(() => checkout(branch, cwd));
    }
    case 'dubstack.delete':
      return mutatingToolResult(() =>
        deleteCommand(cwd, optionalString(args.branch), {
          upstack: optionalBoolean(args.upstack),
          downstack: optionalBoolean(args.downstack),
          force: optionalBoolean(args.force),
          quiet: true,
          interactive: false,
        }),
      );
    default:
      throw new DubError(`Unknown MCP tool '${name}'.`, [
        'Call tools/list to discover the available dubstack.* tool names.',
        'Confirm the client is talking to a current DubStack MCP server build.',
      ]);
  }
}

let stdioCaptureActive = false;

async function mutatingToolResult<T>(
  fn: () => Promise<T>,
): Promise<ToolCallResult> {
  if (stdioCaptureActive) {
    // The server's per-line queue should already serialize tool calls; this
    // guard is defensive against future callers nesting stdio capture, which
    // would corrupt the saved originals and permanently leak the monkey-patch.
    throw new DubError(
      'Internal error: mutatingToolResult invoked while another capture is active.',
      [
        'This is a DubStack invariant violation — please report it.',
        'File a bug at https://github.com/dubstack/dubstack/issues with the surrounding tool call.',
      ],
    );
  }

  stdioCaptureActive = true;
  const captured: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const collect = (chunk: string | Uint8Array): void => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    captured.push(text);
  };

  // Writable.write supports `(chunk, callback)` and `(chunk, encoding, callback)`.
  // Invoke the trailing callback (if any) so callers relying on flush signal don't hang.
  const captureShim = (chunk: string | Uint8Array, ...args: unknown[]) => {
    collect(chunk);
    const callback = args.find((arg) => typeof arg === 'function') as
      | ((error?: Error | null) => void)
      | undefined;
    callback?.(null);
    return true;
  };

  process.stdout.write = captureShim as unknown as typeof process.stdout.write;
  process.stderr.write = captureShim as unknown as typeof process.stderr.write;

  try {
    const value = await fn();
    const structuredContent = toJsonValue({
      result: value,
      output: captured.join(''),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    stdioCaptureActive = false;
  }
}

function optionalSubmitPath(value: unknown): 'current' | 'stack' | undefined {
  if (value === 'current' || value === 'stack') return value;
  return undefined;
}

function initializeResult(
  request: JsonRpcRequest,
  serverVersion: string,
): JsonValue {
  const params = asRecord(request.params);
  const requestedVersion =
    typeof params?.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined;
  const protocolVersion =
    requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: 'dubstack',
      title: 'DubStack',
      version: serverVersion,
      description:
        'DubStack tools for tracked branch stacks. Mutating tools are gated by the configured mcp-mode.',
    },
  };
}

async function appendMcpHistory(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  startedAt: number,
  status: 'success' | 'error',
  output: string[],
): Promise<void> {
  const currentBranch = await getCurrentBranch(cwd).catch(() => undefined);
  const operation = await detectActiveOperation(cwd).catch(() => undefined);
  const argsText = formatHistoryArgs(name, args);
  const command =
    argsText === null
      ? `dub mcp tools/call ${name}`
      : `dub mcp tools/call ${name} ${argsText}`;

  await appendHistoryEntry(cwd, {
    timestamp: new Date(startedAt).toISOString(),
    command,
    status,
    durationMs: Date.now() - startedAt,
    output,
    errorMessage: status === 'error' ? output.join('\n') : undefined,
    context: {
      currentBranch,
      operation,
    },
  }).catch(() => {
    // MCP responses should not fail because audit history could not be written.
  });
}

function formatHistoryArgs(
  name: string,
  args: Record<string, unknown>,
): string | null {
  const keys = HISTORY_ARG_KEYS[name] ?? [];
  const filteredArgs: Record<string, unknown> = {};

  for (const key of keys) {
    if (Object.hasOwn(args, key)) {
      filteredArgs[key] = args[key];
    }
  }

  const argsText = JSON.stringify(filteredArgs);
  if (!argsText || argsText === '{}') return null;

  const redactedArgs = redactSensitiveText(argsText);
  if (redactedArgs.length <= MAX_HISTORY_ARGS_LENGTH) {
    return redactedArgs;
  }

  return `${redactedArgs.slice(0, MAX_HISTORY_ARGS_LENGTH)}...`;
}

function jsonToolResult(value: unknown): ToolCallResult {
  const structuredContent = toJsonValue(value);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function writeMessage(output: Writable, message: JsonValue): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function safeWriteMessage(output: Writable, message: JsonValue): void {
  try {
    writeMessage(output, message);
  } catch {
    // Nothing useful remains to do if the client stream has already closed.
  }
}

function parseRequestId(line: string): JsonRpcId {
  try {
    const message = JSON.parse(line.trim()) as unknown;
    if (isJsonRpcRequest(message) && message.id !== undefined) {
      return message.id ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonValue {
  return toJsonValue({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonValue {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
