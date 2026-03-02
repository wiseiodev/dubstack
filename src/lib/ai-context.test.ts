import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import {
  buildAiSystemPrompt,
  buildAiUserPrompt,
  collectAiContext,
} from './ai-context';

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

describe('ai context', () => {
  it('builds a stable system prompt', () => {
    const prompt = buildAiSystemPrompt();
    expect(prompt).toContain('DubStack assistant');
    expect(prompt).toContain('safe');
  });

  it('builds a user prompt including serialized context and user text', () => {
    const prompt = buildAiUserPrompt('help me', {
      generatedAt: '2026-02-21T00:00:00.000Z',
      currentBranch: 'feat/a',
      activeOperation: 'none',
      gitStatusShort: [],
      stack: null,
      doctor: null,
      recentHistory: [],
      recentShellHistory: [],
    });

    expect(prompt).toContain('CONTEXT_START');
    expect(prompt).toContain('"currentBranch": "feat/a"');
    expect(prompt).toContain('USER_PROMPT');
    expect(prompt).toContain('help me');
  });

  it('collects context without throwing in a basic git repo', async () => {
    const context = await collectAiContext(dir, {
      readShellHistory: async () => ['git status', 'dub submit'],
      shellHistoryLimit: 200,
    });
    expect(context.currentBranch).toBe('main');
    expect(Array.isArray(context.gitStatusShort)).toBe(true);
    expect(context.recentShellHistory).toEqual(['git status', 'dub submit']);
  });

  it('truncates and caps shell history context by budget', async () => {
    const context = await collectAiContext(dir, {
      readShellHistory: async () => [
        'a'.repeat(500),
        'b'.repeat(500),
        'c'.repeat(500),
      ],
      shellHistoryLimit: 200,
      shellHistoryLineMaxLength: 100,
      shellHistoryTotalCharBudget: 230,
    });

    expect(context.recentShellHistory).toHaveLength(2);
    expect(context.recentShellHistory[0].length).toBeLessThanOrEqual(103);
    expect(context.recentShellHistory[1].length).toBeLessThanOrEqual(103);
  });
});
