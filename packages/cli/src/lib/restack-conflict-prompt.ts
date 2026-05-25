import select from '@inquirer/select';

export type RestackConflictChoice = 'continue' | 'cancel' | 'exit' | 'ai';

export function restackConflictPromptMessage(branch: string): string {
  return `Conflict on '${branch}'. What would you like to do?`;
}

export function buildRestackConflictChoices(input: {
  showAiOption?: boolean;
}): Array<{ name: string; value: RestackConflictChoice }> {
  const choices: Array<{ name: string; value: RestackConflictChoice }> = [
    {
      name: 'Continue resolving - leave files in conflict state for manual resolution',
      value: 'continue',
    },
    {
      name: 'Cancel and roll back to pre-restack state',
      value: 'cancel',
    },
    {
      name: 'Exit and leave the operation in its current state',
      value: 'exit',
    },
  ];

  if (input.showAiOption) {
    choices.push({
      name: 'Let AI resolve (shows reasoning before applying)',
      value: 'ai',
    });
  }

  return choices;
}

export async function restackConflictPrompt(input: {
  branch: string;
  showAiOption?: boolean;
}): Promise<RestackConflictChoice> {
  return select<RestackConflictChoice>({
    message: restackConflictPromptMessage(input.branch),
    choices: buildRestackConflictChoices({
      showAiOption: input.showAiOption,
    }),
  });
}

/**
 * Resolve the restack conflict decision. In non-interactive mode, default to
 * `continue` so the existing "resolve and run dub continue" UX is preserved.
 */
export async function resolveRestackConflictDecision(input: {
  branch: string;
  interactive: boolean;
  showAiOption?: boolean;
  promptChoice: (branch: string) => Promise<RestackConflictChoice>;
}): Promise<RestackConflictChoice> {
  if (!input.interactive) return 'continue';
  return input.promptChoice(input.branch);
}
