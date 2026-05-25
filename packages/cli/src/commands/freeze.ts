import { applyFreezeFlag, type FreezeResult } from '../lib/freeze';

export interface FreezeCommandOptions {
  upstack?: boolean;
  downstack?: boolean;
}

/**
 * Sets the `frozen` flag on a tracked branch. Surfaces in `dub log` (🔒)
 * and `dub doctor`; branch-mutating maintenance skips frozen branches until
 * the user explicitly unfreezes them.
 *
 * - `branch` defaults to the current branch when omitted.
 * - `--downstack` cascades through ancestors toward trunk (root excluded).
 * - `--upstack` cascades through descendants.
 *
 * @throws {DubError} If the branch is not tracked, is the root, or both
 *   `--upstack` and `--downstack` are passed.
 */
export async function freeze(
  cwd: string,
  branch?: string,
  options: FreezeCommandOptions = {},
): Promise<FreezeResult> {
  return applyFreezeFlag({
    cwd,
    options: { branch, upstack: options.upstack, downstack: options.downstack },
    frozen: true,
    commandLabel: 'dub freeze',
    undoOperation: 'freeze',
  });
}
