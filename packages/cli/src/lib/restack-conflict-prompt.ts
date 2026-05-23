import select from '@inquirer/select';

export type RestackConflictChoice = 'continue' | 'cancel' | 'exit';

export function restackConflictPromptMessage(branch: string): string {
  return `Conflict on '${branch}'. What would you like to do?`;
}

export async function restackConflictPrompt(input: {
  branch: string;
}): Promise<RestackConflictChoice> {
  return select<RestackConflictChoice>({
    message: restackConflictPromptMessage(input.branch),
    choices: [
      {
        name: 'Continue resolving — leave files in conflict state for manual resolution',
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
    ],
  });
}

/**
 * Resolve the restack conflict decision. In non-interactive mode, default to
 * `continue` so the existing "resolve and run dub continue" UX is preserved.
 */
export async function resolveRestackConflictDecision(input: {
  branch: string;
  interactive: boolean;
  promptChoice: (branch: string) => Promise<RestackConflictChoice>;
}): Promise<RestackConflictChoice> {
  if (!input.interactive) return 'continue';
  return input.promptChoice(input.branch);
}
