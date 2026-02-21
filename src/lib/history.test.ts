import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import {
  appendHistoryEntry,
  readHistory,
  redactSensitiveText,
  sanitizeCommandArgs,
} from './history';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('history', () => {
  it('appends and reads entries newest-first', async () => {
    await appendHistoryEntry(dir, {
      timestamp: '2026-02-21T10:00:00.000Z',
      command: 'dub log',
      status: 'success',
      durationMs: 12,
      output: ['ok'],
    });

    await appendHistoryEntry(dir, {
      timestamp: '2026-02-21T10:01:00.000Z',
      command: 'dub doctor',
      status: 'error',
      durationMs: 20,
      output: ['bad'],
      errorMessage: 'boom',
    });

    const entries = await readHistory(dir, { limit: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0].command).toBe('dub doctor');
    expect(entries[1].command).toBe('dub log');
  });

  it('redacts secret args from command history', () => {
    const sanitized = sanitizeCommandArgs([
      'ai',
      'env',
      '--gemini-key',
      'abc123',
      '--gateway-key=xyz',
    ]);

    expect(sanitized).toEqual([
      'ai',
      'env',
      '--gemini-key',
      '[REDACTED]',
      '--gateway-key=[REDACTED]',
    ]);
  });

  it('redacts sensitive text payloads', () => {
    const redacted = redactSensitiveText(
      [
        "export DUBSTACK_GEMINI_API_KEY='abc'",
        'Authorization: Bearer super-secret-token',
        '{"apiKey":"abcdef"}',
      ].join('\n'),
    );

    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('super-secret-token');
    expect(redacted).toContain('[REDACTED]');
  });
});
