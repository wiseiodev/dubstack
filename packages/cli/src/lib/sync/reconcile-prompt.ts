import select from '@inquirer/select';

export type ReconcilePromptChoice =
  | 'rebase-onto-remote'
  | 'take-remote'
  | 'abort'
  | 'ai';

export interface ReconcilePromptInput {
  branch: string;
  showAiOption?: boolean;
}

export function reconcilePromptHeader(branch: string): string {
  return (
    `${branch} shares a name with a local branch, and they have the same parent.\n` +
    'You can either overwrite your copy of the branch, or rebase your local\n' +
    'changes onto the remote version. You can also abort the command entirely\n' +
    'and keep your local state as is.'
  );
}

export function reconcilePromptMessage(branch: string): string {
  return `How would you like to handle ${branch}?`;
}

export function buildReconcilePromptChoices(input: {
  showAiOption?: boolean;
}): Array<{ name: string; value: ReconcilePromptChoice }> {
  const choices: Array<{ name: string; value: ReconcilePromptChoice }> = [
    {
      name: 'Rebase your changes on top of the remote version',
      value: 'rebase-onto-remote',
    },
    {
      name: 'Overwrite the local copy with the remote version',
      value: 'take-remote',
    },
    {
      name: 'Abort this command',
      value: 'abort',
    },
  ];

  if (input.showAiOption) {
    choices.push({
      name: 'Let AI decide (shows reasoning before applying)',
      value: 'ai',
    });
  }

  return choices;
}

export async function reconcilePrompt(
  input: ReconcilePromptInput,
): Promise<ReconcilePromptChoice> {
  console.log(reconcilePromptHeader(input.branch));
  console.log('');
  return select<ReconcilePromptChoice>({
    message: reconcilePromptMessage(input.branch),
    choices: buildReconcilePromptChoices({
      showAiOption: input.showAiOption,
    }),
  });
}
