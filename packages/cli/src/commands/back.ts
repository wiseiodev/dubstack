import {
  type CheckoutEntry,
  popCheckoutHistory,
  readCheckoutHistory,
} from '../lib/checkout-history';
import { DubError } from '../lib/errors';
import { branchExists, checkoutBranch, getCurrentBranch } from '../lib/git';

export interface BackResult {
  branch: string;
  skipped: CheckoutEntry[];
  popped: CheckoutEntry[];
}

export async function back(
  cwd: string,
  steps: number = 1,
): Promise<BackResult> {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new DubError('Back steps must be a positive integer.', [
      "Pass a positive integer, for example 'dub back 2'.",
    ]);
  }

  const currentBranch = await getCurrentBranch(cwd).catch(() => null);
  const result = await popCheckoutHistory(cwd, steps, {
    currentBranch,
    branchExists: (branch) => branchExists(branch, cwd),
    checkoutBranch: (branch) => checkoutBranch(branch, cwd),
  });

  if (!result.target) {
    throw new DubError('No checkout history available.', [
      "Run 'dub co <branch>' or another DubStack navigation command first.",
      "Run 'dub back --list' to inspect the current checkout history.",
    ]);
  }

  return {
    branch: result.target.branch,
    skipped: result.skipped,
    popped: result.popped,
  };
}

export async function listBackHistory(cwd: string): Promise<CheckoutEntry[]> {
  return readCheckoutHistory(cwd);
}
