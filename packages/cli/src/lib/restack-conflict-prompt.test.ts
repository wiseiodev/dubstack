import { describe, expect, it, vi } from 'vitest';
import {
  buildRestackConflictChoices,
  resolveRestackConflictDecision,
  restackConflictPromptMessage,
} from './restack-conflict-prompt';

describe('restackConflictPromptMessage (DUB-15 verbatim)', () => {
  it("renders the verbatim 'Conflict on <branch>' message", () => {
    expect(restackConflictPromptMessage('feat/auth-ui')).toBe(
      "Conflict on 'feat/auth-ui'. What would you like to do?",
    );
  });
});

describe('resolveRestackConflictDecision', () => {
  it('hides the AI choice by default', () => {
    expect(
      buildRestackConflictChoices({}).map((choice) => choice.value),
    ).toEqual(['continue', 'cancel', 'exit']);
  });

  it('can include the AI choice when enabled', () => {
    expect(
      buildRestackConflictChoices({ showAiOption: true }).map(
        (choice) => choice.value,
      ),
    ).toEqual(['continue', 'cancel', 'exit', 'ai']);
  });

  it('defaults to continue in non-interactive mode (preserves existing UX)', async () => {
    const promptChoice = vi.fn();
    const decision = await resolveRestackConflictDecision({
      branch: 'feat/a',
      interactive: false,
      promptChoice,
    });
    expect(decision).toBe('continue');
    expect(promptChoice).not.toHaveBeenCalled();
  });

  it('returns user choice in interactive mode', async () => {
    const promptChoice = vi.fn().mockResolvedValue('cancel');
    const decision = await resolveRestackConflictDecision({
      branch: 'feat/a',
      interactive: true,
      promptChoice,
    });
    expect(promptChoice).toHaveBeenCalledWith('feat/a');
    expect(decision).toBe('cancel');
  });

  it('passes through the exit choice', async () => {
    const promptChoice = vi.fn().mockResolvedValue('exit');
    const decision = await resolveRestackConflictDecision({
      branch: 'feat/a',
      interactive: true,
      promptChoice,
    });
    expect(decision).toBe('exit');
  });

  it('passes through the AI choice', async () => {
    const promptChoice = vi.fn().mockResolvedValue('ai');
    const decision = await resolveRestackConflictDecision({
      branch: 'feat/a',
      interactive: true,
      promptChoice,
    });
    expect(decision).toBe('ai');
  });
});
