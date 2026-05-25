import type { Command } from 'commander';
import {
  type CompletionShell,
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from '../lib/completion';
import { DubError } from '../lib/errors';

export function completion(program: Command, shell: string): string {
  switch (shell) {
    case 'bash':
      return generateBashCompletion(program);
    case 'zsh':
      return generateZshCompletion(program);
    case 'fish':
      return generateFishCompletion(program);
    default:
      throw new DubError(`Unsupported shell '${shell}'.`, [
        "Pass 'bash', 'zsh', or 'fish' as the shell argument.",
        "Example: 'dub completion zsh > ~/.zsh/completions/_dub'.",
      ]);
  }
}

export type { CompletionShell };
