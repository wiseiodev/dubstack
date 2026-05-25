import { describe, expect, it } from 'vitest';
import {
  buildReconcilePromptChoices,
  reconcilePromptHeader,
  reconcilePromptMessage,
} from './reconcile-prompt';

describe('reconcile prompt wording (DUB-15 verbatim)', () => {
  it('renders the four-line header with the branch name', () => {
    const header = reconcilePromptHeader('feat/auth-ui');
    expect(header).toBe(
      'feat/auth-ui shares a name with a local branch, and they have the same parent.\n' +
        'You can either overwrite your copy of the branch, or rebase your local\n' +
        'changes onto the remote version. You can also abort the command entirely\n' +
        'and keep your local state as is.',
    );
  });

  it('uses the verbatim "How would you like to handle <branch>?" message', () => {
    expect(reconcilePromptMessage('feat/auth-ui')).toBe(
      'How would you like to handle feat/auth-ui?',
    );
  });

  it('hides the AI choice by default', () => {
    expect(
      buildReconcilePromptChoices({}).map((choice) => choice.value),
    ).toEqual(['rebase-onto-remote', 'take-remote', 'abort']);
  });

  it('can include the AI choice when enabled', () => {
    expect(
      buildReconcilePromptChoices({ showAiOption: true }).map(
        (choice) => choice.value,
      ),
    ).toEqual(['rebase-onto-remote', 'take-remote', 'abort', 'ai']);
  });
});
