import type { ReconcilePromptChoice } from './reconcile-prompt';

export type ReconcileDecision =
  | 'rebase-onto-remote'
  | 'take-remote'
  | 'abort'
  | 'ai';

/**
 * Resolves the three-way reconcile decision for a branch that diverged from
 * its remote while sharing the same parent.
 *
 * Flag semantics (verbatim from DUB-15 / Graphite v1.7.18):
 * - `--force` alone does NOT skip the interactive prompt.
 * - `--no-interactive` and no `--force` → ABORT (safest).
 * - `--force` AND `--no-interactive` → take-remote.
 * - Otherwise → ask the user. There is no default — the user must select.
 */
export async function resolveReconcileDecision(input: {
  branch: string;
  force: boolean;
  interactive: boolean;
  promptChoice: () => Promise<ReconcilePromptChoice>;
}): Promise<ReconcileDecision> {
  if (!input.interactive) {
    return input.force ? 'take-remote' : 'abort';
  }
  return input.promptChoice();
}
