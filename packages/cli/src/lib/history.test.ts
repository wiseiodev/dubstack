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
      '--anthropic-key=sk-ant-123',
      '--gateway-key=xyz',
    ]);

    expect(sanitized).toEqual([
      'ai',
      'env',
      '--gemini-key',
      '[REDACTED]',
      '--anthropic-key=[REDACTED]',
      '--gateway-key=[REDACTED]',
    ]);
  });

  it('redacts --openai-key args in both spaced and = forms', () => {
    const sanitized = sanitizeCommandArgs([
      'ai',
      'env',
      '--openai-key',
      'sk-proj-abc123_DEF-456ghiJKLmno0pqRstuVwx',
      '--openai-key=sk-proj-zzz999_YYY-888xxxWWWvvvUUU',
    ]);

    expect(sanitized).toEqual([
      'ai',
      'env',
      '--openai-key',
      '[REDACTED]',
      '--openai-key=[REDACTED]',
    ]);
  });

  it('does not redact non-secret model args', () => {
    const sanitized = sanitizeCommandArgs([
      'ai',
      'env',
      '--gemini-model',
      'gemini-2.5-pro',
      '--gateway-model=google/gemini-3-flash',
    ]);

    expect(sanitized).toEqual([
      'ai',
      'env',
      '--gemini-model',
      'gemini-2.5-pro',
      '--gateway-model=google/gemini-3-flash',
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

  it('redacts modern openai/anthropic key formats containing - and _', () => {
    const redacted = redactSensitiveText(
      [
        'dub ai env --openai-key sk-proj-abc123_DEF-456ghiJKLmno0pqRstuVwx',
        'pasted sk-ant-api03-abc_def-ghiJKLmno0pqRstuVwx12345 into a note',
      ].join('\n'),
    );

    expect(redacted).not.toContain('sk-proj-');
    expect(redacted).not.toContain('sk-ant-');
    expect(redacted).toContain('[REDACTED]');
  });

  it('does not redact short sk- branch names', () => {
    expect(redactSensitiveText('git checkout sk-fix-login')).toBe(
      'git checkout sk-fix-login',
    );
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
