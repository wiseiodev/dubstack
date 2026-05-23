import { describe, expect, it, vi } from 'vitest';
import { resolveReconcileDecision } from './reconcile';

describe('resolveReconcileDecision', () => {
  it('aborts in non-interactive mode without force (safest default)', async () => {
    const promptChoice = vi.fn();
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: false,
      interactive: false,
      promptChoice,
    });
    expect(decision).toBe('abort');
    expect(promptChoice).not.toHaveBeenCalled();
  });

  it('takes remote with --force AND --no-interactive', async () => {
    const promptChoice = vi.fn();
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: true,
      interactive: false,
      promptChoice,
    });
    expect(decision).toBe('take-remote');
    expect(promptChoice).not.toHaveBeenCalled();
  });

  it('still prompts when --force alone (interactive shell)', async () => {
    const promptChoice = vi.fn().mockResolvedValue('rebase-onto-remote');
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: true,
      interactive: true,
      promptChoice,
    });
    expect(promptChoice).toHaveBeenCalledOnce();
    expect(decision).toBe('rebase-onto-remote');
  });

  it('prompts in interactive mode without force and returns user choice', async () => {
    const promptChoice = vi.fn().mockResolvedValue('take-remote');
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: false,
      interactive: true,
      promptChoice,
    });
    expect(promptChoice).toHaveBeenCalledOnce();
    expect(decision).toBe('take-remote');
  });

  it('returns abort when user selects abort', async () => {
    const promptChoice = vi.fn().mockResolvedValue('abort');
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: false,
      interactive: true,
      promptChoice,
    });
    expect(decision).toBe('abort');
  });
});
