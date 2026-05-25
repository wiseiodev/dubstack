import { applyFreezeFlag, type FreezeResult } from '../lib/freeze';

export interface FreezeCommandOptions {
  upstack?: boolean;
  downstack?: boolean;
}

/**
 * Sets the `frozen` flag on a tracked branch. Surfaces in `dub log` (🔒)
 * and `dub doctor`.
 *
 * Note: this is a passive marker only. `dub restack` and `dub sync` do
 * NOT yet read this field — the enforcement wiring is tracked separately
 * as DUB-82.
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
