import { describe, expect, it, vi } from 'vitest';
import { resolveReconcileDecision } from './reconcile';

describe('resolveReconcileDecision', () => {
  it('takes remote when force is enabled', async () => {
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: true,
      interactive: false,
      promptChoice: vi.fn(),
    });
    expect(decision).toBe('take-remote');
  });

  it('skips in non-interactive mode without force', async () => {
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: false,
      interactive: false,
      promptChoice: vi.fn(),
    });
    expect(decision).toBe('skip');
  });

  it('uses prompt response in interactive mode', async () => {
    const promptChoice = vi.fn().mockResolvedValue('keep-local');
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: false,
      interactive: true,
      promptChoice,
    });
    expect(promptChoice).toHaveBeenCalled();
    expect(decision).toBe('keep-local');
  });

  it('falls back to skip for unknown prompt answer', async () => {
    const decision = await resolveReconcileDecision({
      branch: 'feat/a',
      force: false,
      interactive: true,
      promptChoice: vi.fn().mockResolvedValue('unknown'),
    });
    expect(decision).toBe('skip');
  });
});
