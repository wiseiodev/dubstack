import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import {
  appendHistoryEntry,
  normalizeHistoryLine,
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
      invocationMode: 'shortcut-fallback',
      typoGuardTriggered: true,
      webBrowsingRequested: true,
      webBrowsingUsed: false,
    });

    const entries = await readHistory(dir, { limit: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0].command).toBe('dub doctor');
    expect(entries[0].invocationMode).toBe('shortcut-fallback');
    expect(entries[0].webBrowsingUsed).toBe(false);
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

  it('normalizes carriage-return spinner lines to the final visible content', () => {
    expect(normalizeHistoryLine('- thinking\r\\ thinking\rfinal output')).toBe(
      'final output',
    );
  });

  it('returns empty string when normalized content is whitespace only', () => {
    expect(normalizeHistoryLine('progress\r   \t   ')).toBe('');
  });

  it('keeps regular lines without carriage returns unchanged', () => {
    expect(normalizeHistoryLine('plain output line')).toBe('plain output line');
  });
});
