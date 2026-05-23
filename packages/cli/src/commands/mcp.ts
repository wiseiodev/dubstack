import type { Readable, Writable } from 'node:stream';
import { DubError, formatDubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { getBranchPrSyncInfo } from '../lib/github';
import { appendHistoryEntry, redactSensitiveText } from '../lib/history';
import { detectActiveOperation } from '../lib/operation-state';
import { branchInfo } from './branch';
import { children } from './children';
import { type DoctorIssue, doctor } from './doctor';
import { history } from './history';
import { logJson } from './log';
import { parent } from './parent';
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

interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  version?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
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
];

export async function mcp(
  cwd: string,
  options: McpServerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const serverVersion = options.version ?? '0.0.0';
  let buffer = '';
  let queue: Promise<void> = Promise.resolve();

  input.setEncoding('utf8');

  await new Promise<void>((resolve) => {
    const enqueue = (line: string) => {
      queue = queue
        .catch(() => undefined)
        .then(() => handleLineSafely(line, cwd, output, serverVersion));
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
): Promise<void> {
  try {
    await handleLine(line, cwd, output, serverVersion);
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

  const response = await handleRequest(message, cwd, serverVersion);
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
      return handleToolCallRequest(request, cwd);
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
): Promise<JsonValue> {
  const params = asRecord(request.params);
  const name = typeof params?.name === 'string' ? params.name : null;
  const args = asRecord(params?.arguments) ?? {};

  if (!name) {
    return jsonRpcError(request.id ?? null, -32602, 'Missing tool name.');
  }

  if (!TOOLS.some((tool) => tool.name === name)) {
    await appendMcpHistory(cwd, name, args, Date.now(), 'error', [
      `Unknown MCP tool '${name}'.`,
    ]);
    return jsonRpcError(request.id ?? null, -32602, `Unknown tool: ${name}`);
  }

  const startedAt = Date.now();
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
    default:
      throw new DubError(`Unknown MCP tool '${name}'.`);
  }
}

async function status(cwd: string): Promise<JsonValue> {
  const currentBranch = await getCurrentBranch(cwd);
  const info = await branchInfo(cwd, currentBranch);
  const operation = await detectActiveOperation(cwd);
  const pr = await getBranchPrSyncInfo(currentBranch, cwd).catch((error) => ({
    state: 'UNKNOWN' as const,
    baseRefName: null,
    error: error instanceof Error ? error.message : String(error),
  }));
  const health = await doctor(cwd, { all: false, fetch: false });
  const drift = health.issues.filter(isDriftIssue);

  return toJsonValue({
    currentBranch,
    operation,
    branch: {
      tracked: info.tracked,
      stackId: info.stackId,
      root: info.root,
      parent: info.parent,
      children: info.children,
    },
    pr,
    drift: {
      healthy: drift.length === 0,
      issues: drift,
    },
  });
}

function isDriftIssue(issue: DoctorIssue): boolean {
  return (
    issue.code === 'parent-mismatch' ||
    issue.code === 'remote-base-mismatch' ||
    issue.code === 'missing-local' ||
    issue.code === 'missing-remote' ||
    issue.code === 'remote-drift' ||
    issue.code === 'remote-check-failed'
  );
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
      description: 'Read-only DubStack tools for tracked branch stacks.',
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
