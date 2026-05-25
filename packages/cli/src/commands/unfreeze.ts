import { applyFreezeFlag, type FreezeResult } from '../lib/freeze';

export interface UnfreezeCommandOptions {
  upstack?: boolean;
  downstack?: boolean;
}

/**
 * Clears the `frozen` flag on a tracked branch. Defaults to the current
 * branch.
 *
 * Note: the `frozen` flag is currently a passive marker. `dub restack`
 * and `dub sync` do NOT yet read it, so clearing the flag has no effect
 * on rebase behavior until DUB-82 lands.
 *
 * @throws {DubError} If the branch is not tracked, is the root, or both
 *   `--upstack` and `--downstack` are passed.
 */
export async function unfreeze(
  cwd: string,
  branch?: string,
  options: UnfreezeCommandOptions = {},
): Promise<FreezeResult> {
  return applyFreezeFlag({
    cwd,
    options: { branch, upstack: options.upstack, downstack: options.downstack },
    frozen: false,
    commandLabel: 'dub unfreeze',
    undoOperation: 'unfreeze',
  });
}
