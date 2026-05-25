import { applyFreezeFlag, type FreezeResult } from '../lib/freeze';

export interface UnfreezeCommandOptions {
  upstack?: boolean;
  downstack?: boolean;
}

/**
 * Clears the `frozen` flag on a tracked branch. Defaults to the current
 * branch. Restack, sync, and post-merge can mutate the branch again after
 * this flag is cleared.
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
