import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDubDir } from './state';

export interface DubHistoryEntry {
  timestamp: string;
  command: string;
  status: 'success' | 'error';
  durationMs: number;
  output: string[];
  errorMessage?: string;
  invocationMode?: 'explicit-ai' | 'shortcut-fallback' | 'shortcut-forced';
  typoGuardTriggered?: boolean;
  webBrowsingRequested?: boolean;
  webBrowsingUsed?: boolean;
  context?: {
    currentBranch?: string;
    operation?: string;
  };
}

const REDACTED_ARGS = new Set([
  '--gemini-key',
  '--anthropic-key',
  '--gateway-key',
]);
const REDACTED_PLACEHOLDER = '[REDACTED]';

export async function getHistoryPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'history.jsonl');
}

export async function appendHistoryEntry(
  cwd: string,
  entry: DubHistoryEntry,
): Promise<void> {
  const historyPath = await getHistoryPath(cwd);
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sanitizedEntry: DubHistoryEntry = {
    ...entry,
    command: redactSensitiveText(entry.command),
    output: entry.output.map((line) => redactSensitiveText(line)),
    errorMessage: entry.errorMessage
      ? redactSensitiveText(entry.errorMessage)
      : undefined,
  };

  fs.appendFileSync(
    historyPath,
    `${JSON.stringify(sanitizedEntry)}\n`,
    'utf-8',
  );
}

export async function readHistory(
  cwd: string,
  options: { limit?: number } = {},
): Promise<DubHistoryEntry[]> {
  const historyPath = await getHistoryPath(cwd);
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  const raw = fs.readFileSync(historyPath, 'utf-8').trim();
  if (!raw) {
    return [];
  }

  const entries = raw
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as DubHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DubHistoryEntry => entry !== null);

  const limit = options.limit ?? 20;
  if (limit <= 0) {
    return [];
  }

  return entries.slice(-limit).reverse();
}

export function sanitizeCommandArgs(args: string[]): string[] {
  const sanitized: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    sanitized.push(arg);

    if (REDACTED_ARGS.has(arg)) {
      if (i + 1 < args.length) {
        sanitized.push(REDACTED_PLACEHOLDER);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--gemini-key=')) {
      sanitized[sanitized.length - 1] = `--gemini-key=${REDACTED_PLACEHOLDER}`;
      continue;
    }

    if (arg.startsWith('--anthropic-key=')) {
      sanitized[sanitized.length - 1] =
        `--anthropic-key=${REDACTED_PLACEHOLDER}`;
      continue;
    }

    if (arg.startsWith('--gateway-key=')) {
      sanitized[sanitized.length - 1] = `--gateway-key=${REDACTED_PLACEHOLDER}`;
    }
  }

  return sanitized;
}

export function redactSensitiveText(value: string): string {
  let redacted = value;

  redacted = redacted.replace(
    /\b(export\s+)?([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*(['"]?)[^'"\s]+(['"]?)/g,
    (_match, exportPrefix = '', name, quoteStart = '', quoteEnd = '') =>
      `${exportPrefix}${name}=${quoteStart}${REDACTED_PLACEHOLDER}${quoteEnd}`,
  );

  redacted = redacted.replace(
    /("?(?:api[_-]?key|token|secret|password)"?\s*:\s*")[^"]*(")/gi,
    `$1${REDACTED_PLACEHOLDER}$2`,
  );

  redacted = redacted.replace(
    /\b(Bearer\s+)[A-Za-z0-9._-]+/gi,
    `$1${REDACTED_PLACEHOLDER}`,
  );

  redacted = redacted.replace(
    /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
    REDACTED_PLACEHOLDER,
  );

  redacted = redacted.replace(/\bsk-[A-Za-z0-9]{12,}\b/g, REDACTED_PLACEHOLDER);

  return redacted;
}

export function normalizeHistoryLine(line: string): string {
  const visible = line.split('\r').pop() ?? '';
  return visible.trim().length === 0 ? '' : visible;
}
