import search from '@inquirer/search';
import { appendCheckoutHistory } from '../lib/checkout-history';
import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  getCurrentBranch,
  listBranches,
} from '../lib/git';
import { type DubState, findStackForBranch, readState } from '../lib/state';

/**
 * Returns a sorted, deduplicated list of branch names tracked by DubStack.
 * Root branches that appear in multiple stacks are included only once.
 */
export function getTrackedBranches(state: DubState): string[] {
  const names = new Set<string>();
  for (const stack of state.stacks) {
    for (const branch of stack.branches) {
      names.add(branch.name);
    }
  }
  return [...names].sort();
}

/**
 * Filters tracked branches against the list of actual local git branches.
 * Removes any branches that are tracked in state but have been deleted locally.
 */
export function getValidBranches(tracked: string[], local: string[]): string[] {
  const localSet = new Set(local);
  return tracked.filter((b) => localSet.has(b));
}

/**
 * Returns tracked branch names in the current stack (ancestors + descendants),
 * including the provided branch itself.
 */
export function getStackRelativeBranches(
  state: DubState,
  branchName: string,
): string[] {
  const stack = findStackForBranch(state, branchName);
  if (!stack) return [];
  return [...new Set(stack.branches.map((branch) => branch.name))].sort();
}

/**
 * Resolves the current trunk branch for the active stack.
 * Falls back to local "main" or "master" if the current branch is untracked.
 */
export async function resolveCheckoutTrunk(cwd: string): Promise<string> {
  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const stack = findStackForBranch(state, currentBranch);
  const trackedRoot =
    stack?.branches.find((branch) => branch.type === 'root')?.name ?? null;
  if (trackedRoot) return trackedRoot;
  if (await branchExists('main', cwd)) return 'main';
  if (await branchExists('master', cwd)) return 'master';
  throw new DubError(
    `Could not determine trunk branch for '${currentBranch}'.`,
    [
      "Run 'dub track <branch> --parent <trunk>' to attach this branch to a known trunk.",
      "Run 'dub log' to inspect the stack and find the intended trunk.",
      "Pass the trunk branch name explicitly to 'dub checkout <branch>'.",
    ],
  );
}

/**
 * Checks out the named branch.
 *
 * @param name - Branch to switch to
 * @param cwd - Working directory
 * @returns The checked-out branch name
 * @throws {DubError} If the branch does not exist
 */
export async function checkout(
  name: string,
  cwd: string,
): Promise<{ branch: string }> {
  await checkoutBranch(name, cwd);
  await appendCheckoutHistory(cwd, name, { via: 'checkout' });
  return { branch: name };
}

/**
 * Launches an interactive search prompt listing DubStack-tracked branches.
 *
 * The current branch is shown but disabled. The user can type to filter,
 * use arrow keys to navigate, and press Enter to checkout.
 *
 * @param cwd - Working directory
 * @returns The checked-out branch, or `null` if the user cancelled (Ctrl+C)
 * @throws {DubError} If not initialized or no tracked branches exist
 */
export async function interactiveCheckout(
  cwd: string,
  options: {
    showUntracked?: boolean;
    stack?: boolean;
    all?: boolean;
  } = {},
): Promise<{ branch: string } | null> {
  const state = await readState(cwd);
  const localBranches = await listBranches(cwd);
  const currentBranch = await getCurrentBranch(cwd).catch(() => null);
  const trackedBranches = getTrackedBranches(state);
  const stackBranches = currentBranch
    ? getStackRelativeBranches(state, currentBranch)
    : [];

  let branchCandidates = options.showUntracked
    ? [...new Set(localBranches)].sort()
    : getValidBranches(trackedBranches, localBranches);

  if (options.stack && stackBranches.length > 0) {
    const stackSet = new Set(stackBranches);
    branchCandidates = branchCandidates.filter((name) => stackSet.has(name));
  }

  const validBranches = branchCandidates;

  if (validBranches.length === 0) {
    throw new DubError('No valid tracked branches found.', [
      "Run 'dub create <branch>' to start a stack.",
      "Run 'dub track <branch>' to track an existing branch.",
      "Rerun 'dub checkout --show-untracked' to also list untracked branches.",
    ]);
  }

  // Setup AbortController for Esc key support
  const controller = new AbortController();

  // Listen for keypress events to handle Esc
  const onKeypress = (_str: string, key: { name: string; ctrl: boolean }) => {
    if (key && key.name === 'escape') {
      controller.abort();
    }
  };
  process.stdin.on('keypress', onKeypress);

  try {
    const selected = await search(
      {
        message: 'Checkout a branch (autocomplete or arrow keys)',
        source(term: string | undefined) {
          const filtered = term
            ? validBranches.filter((b) =>
                b.toLowerCase().includes(term.toLowerCase()),
              )
            : validBranches;

          return filtered.map((name) => ({
            name,
            value: name,
            disabled: name === currentBranch ? '(current)' : false,
          }));
        },
      },
      { signal: controller.signal },
    );

    return checkout(selected, cwd);
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (
        error.name === 'ExitPromptError' ||
        error.name === 'AbortError' ||
        error.name === 'AbortPromptError'
      ) {
        return null;
      }
    }
    throw error;
  } finally {
    process.stdin.off('keypress', onKeypress);
  }
}
