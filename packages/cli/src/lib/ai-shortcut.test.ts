import { describe, expect, it, vi } from 'vitest';
import {
  collectKnownTopLevelCommands,
  preprocessCliArgs,
  type ShortcutChoice,
} from './ai-shortcut';

describe('collectKnownTopLevelCommands', () => {
  it('includes command names and aliases', () => {
    const known = collectKnownTopLevelCommands([
      { name: () => 'submit', aliases: () => ['ss'] },
      { name: () => 'checkout', aliases: () => ['co'] },
      { name: () => 'ai', aliases: () => [] },
    ]);

    expect(known.has('submit')).toBe(true);
    expect(known.has('ss')).toBe(true);
    expect(known.has('co')).toBe(true);
  });
});

describe('preprocessCliArgs', () => {
  const known = new Set(['submit', 'create', 'ai', 'history']);

  it('keeps known command args unchanged', async () => {
    const result = await preprocessCliArgs(
      ['submit', '--dry-run'],
      known,
      false,
      vi.fn(),
    );

    expect(result.finalArgs).toEqual(['submit', '--dry-run']);
    expect(result.metadata.invocationMode).toBeUndefined();
  });

  it('routes unknown command-like input to ai ask', async () => {
    const result = await preprocessCliArgs(
      ['what', 'changed', 'today?'],
      known,
      false,
      vi.fn(),
    );

    expect(result.finalArgs).toEqual([
      'ai',
      'ask',
      'what',
      'changed',
      'today?',
    ]);
    expect(result.metadata.invocationMode).toBe('shortcut-fallback');
    expect(result.metadata.typoGuardTriggered).toBe(false);
  });

  it('forces ai route with --ai', async () => {
    const result = await preprocessCliArgs(
      ['--ai', 'submit', 'branch', 'status'],
      known,
      false,
      vi.fn(),
    );

    expect(result.finalArgs).toEqual([
      'ai',
      'ask',
      'submit',
      'branch',
      'status',
    ]);
    expect(result.metadata.invocationMode).toBe('shortcut-forced');
  });

  it('errors when --ai is provided without a prompt', async () => {
    await expect(
      preprocessCliArgs(['--ai'], known, false, vi.fn()),
    ).rejects.toThrow('Prompt cannot be empty');
  });

  it('fails non-interactive likely typos with suggestion', async () => {
    await expect(
      preprocessCliArgs(['submt'], known, false, vi.fn()),
    ).rejects.toThrow("Did you mean 'submit'");
  });

  it('uses interactive typo choice when tty is available', async () => {
    const choose = vi
      .fn<(_: string, __: string) => Promise<ShortcutChoice>>()
      .mockResolvedValue('ask-ai');
    const result = await preprocessCliArgs(['submt'], known, true, choose);

    expect(result.finalArgs).toEqual(['ai', 'ask', 'submt']);
    expect(result.metadata.invocationMode).toBe('shortcut-fallback');
    expect(result.metadata.typoGuardTriggered).toBe(true);
  });
});
