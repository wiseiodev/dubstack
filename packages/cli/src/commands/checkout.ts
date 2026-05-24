import chalk from 'chalk';
import { execa } from 'execa';
import {
  type BranchPickerChoice,
  type BranchPickerOutcome,
  branchPickerPrompt,
} from '../lib/branch-picker';
import { formatBranchLabel } from '../lib/branch-picker-format';
import { appendCheckoutHistory } from '../lib/checkout-history';
import { copyToClipboard } from '../lib/clipboard';
import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  getCurrentBranch,
  listBranches,
} from '../lib/git';
import { openPrInBrowser } from '../lib/github';
import {
  type BranchOverview,
  getStackOverviewBatch,
  type StackOverview,
} from '../lib/stack-overview';
import {
  type DubState,
  findStackForBranch,
  getParent,
  readState,
} from '../lib/state';
import { computeRegions, type LogRegion } from './log';

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
 * Computes region tags for every tracked branch across every stack.
 *
 * Stacks that don't contain the current branch get `descendant` for all
 * non-root rows (per {@link computeRegions}), so they render neutrally.
 */
export function computeAllRegions(
  state: DubState,
  currentBranch: string | null,
): Map<string, LogRegion> {
  const merged = new Map<string, LogRegion>();
  for (const stack of state.stacks) {
    const stackRegions = computeRegions(stack, currentBranch);
    for (const [name, region] of stackRegions) {
      // Prefer a more-specific region if the same root branch appears in
      // two stacks (e.g. `main`). `current`/`ancestor` win over `root`,
      // which wins over the descendant/sibling fallbacks.
      const existing = merged.get(name);
      if (!existing || regionRank(region) > regionRank(existing)) {
        merged.set(name, region);
      }
    }
  }
  return merged;
}

function regionRank(region: LogRegion): number {
  // Higher rank wins when the same branch is classified differently across
  // stacks. Intent: most-specific-to-current wins over the generic root /
  // sibling fallbacks, but `root` still beats the per-stack fallbacks
  // (`descendant` / `sibling-subtree`) so a shared trunk stays bold.
  switch (region) {
    case 'current':
      return 5;
    case 'ancestor':
      return 4;
    case 'root':
      return 3;
    case 'descendant':
      return 2;
    case 'sibling-subtree':
      return 1;
  }
}

export interface InteractiveCheckoutOptions {
  showUntracked?: boolean;
  stack?: boolean;
  all?: boolean;
  refresh?: boolean;
  /** Disable ANSI colors (mirrors `dub log --no-color`). */
  noColor?: boolean;
}

interface BuildChoicesArgs {
  validBranches: string[];
  currentBranch: string | null;
  regions: Map<string, LogRegion>;
  overview: StackOverview | null;
  noColor: boolean;
}

/**
 * Builds the picker choice rows. Exported so tests can exercise the
 * formatting + region styling without spinning up the prompt.
 */
export function buildBranchChoices(
  args: BuildChoicesArgs,
): BranchPickerChoice[] {
  const { validBranches, currentBranch, regions, overview, noColor } = args;
  const overviewByBranch = new Map<string, BranchOverview>();
  if (overview) {
    for (const row of overview.branches) overviewByBranch.set(row.branch, row);
  }
  const branchColumnWidth = Math.min(
    Math.max(...validBranches.map((b) => b.length), 0) + 2,
    48,
  );

  return validBranches.map((name) => {
    const label = formatBranchLabel({
      branch: name,
      region: regions.get(name),
      overview: overviewByBranch.get(name) ?? null,
      branchColumnWidth,
      noColor,
    });
    return {
      value: name,
      label,
      searchKey: name,
      disabled: name === currentBranch ? '(current)' : undefined,
    };
  });
}

async function safeOverview(
  cwd: string,
  refresh: boolean,
): Promise<{ overview: StackOverview | null; error: string | null }> {
  try {
    const overview = await getStackOverviewBatch(cwd, { refresh });
    return { overview, error: null };
  } catch (err) {
    // PR metadata is best-effort — the picker still works without it.
    const message = err instanceof Error ? err.message : String(err);
    if (/enoent/i.test(message)) {
      return {
        overview: null,
        error: 'gh CLI not installed — install it to see PR metadata',
      };
    }
    return { overview: null, error: message };
  }
}

interface Stylers {
  yellow: (text: string) => string;
  green: (text: string) => string;
}

function makeStylers(noColor: boolean): Stylers {
  if (noColor) {
    return { yellow: (t) => t, green: (t) => t };
  }
  return { yellow: (t) => chalk.yellow(t), green: (t) => chalk.green(t) };
}

async function printDiffAgainstParent(
  branch: string,
  state: DubState,
  cwd: string,
  stylers: Stylers,
): Promise<void> {
  const parent = getParent(state, branch);
  if (!parent) {
    console.log(
      stylers.yellow(`No parent recorded for '${branch}' — nothing to diff.`),
    );
    return;
  }
  if (!(await branchExists(parent, cwd))) {
    console.log(
      stylers.yellow(
        `Parent branch '${parent}' is missing locally — cannot diff '${branch}'.`,
      ),
    );
    return;
  }
  try {
    await execa('git', ['--no-pager', 'diff', `${parent}...${branch}`], {
      cwd,
      stdio: 'inherit',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(stylers.yellow(`Failed to run git diff: ${message}`));
  }
}

async function handlePickerOutcome(
  outcome: BranchPickerOutcome,
  state: DubState,
  cwd: string,
  stylers: Stylers,
): Promise<{ done: { branch: string } | null } | { continueWith: string }> {
  if (outcome.type === 'checkout') {
    return { done: await checkout(outcome.branch, cwd) };
  }
  if (outcome.type === 'cancel') {
    return { done: null };
  }
  if (outcome.type === 'pr') {
    try {
      await openPrInBrowser(cwd, outcome.branch);
    } catch (err) {
      if (err instanceof DubError) {
        console.log(stylers.yellow(err.message));
      } else {
        throw err;
      }
    }
    return { continueWith: outcome.branch };
  }
  if (outcome.type === 'copy') {
    const tool = await copyToClipboard(outcome.branch);
    if (tool) {
      console.log(stylers.green(`✔ Copied '${outcome.branch}' to clipboard`));
    } else {
      console.log(stylers.yellow('(copy unavailable)'));
    }
    return { continueWith: outcome.branch };
  }
  // outcome.type === 'diff'
  await printDiffAgainstParent(outcome.branch, state, cwd, stylers);
  return { continueWith: outcome.branch };
}

/**
 * Launches an interactive search prompt listing DubStack-tracked branches.
 *
 * Each row shows PR number, review status, CI rollup, and last-commit age
 * (when available from {@link getStackOverviewBatch}), with the branch
 * name colored by stack region.
 *
 * Shortcuts:
 *   - `Enter`        checkout the highlighted branch
 *   - `p`            open the branch's PR in the browser
 *   - `d`            run `git diff <parent>...<branch>` and wait for input
 *   - `c`            copy the branch name to the clipboard (best-effort)
 *   - `Esc` / `q`    cancel
 *
 * After `p`/`d`/`c` the picker is re-launched so the user can chain
 * actions or finally pick a branch. Returns `null` on cancel.
 *
 * @throws {DubError} If not initialized or no tracked branches exist
 */
export async function interactiveCheckout(
  cwd: string,
  options: InteractiveCheckoutOptions = {},
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

  const regions = computeAllRegions(state, currentBranch);

  const noColor =
    options.noColor === true ||
    chalk.level === 0 ||
    process.env.NO_COLOR !== undefined;
  const stylers = makeStylers(noColor);
  const dim: (t: string) => string = noColor ? (t) => t : (t) => chalk.dim(t);

  if (options.refresh) {
    console.log(dim('Loading PR data...'));
  }
  const { overview, error: overviewError } = await safeOverview(
    cwd,
    options.refresh === true,
  );
  if (overviewError) {
    console.log(stylers.yellow(`PR metadata unavailable: ${overviewError}`));
  }

  let defaultBranch = currentBranch ?? undefined;
  const footerParts: string[] = [];
  if (overview?.truncated) {
    footerParts.push(
      dim(
        `ℹ Showing ${overview.branches.length}+ branches — some PR data may be stale`,
      ),
    );
  }

  // Side-effect actions (p/d/c) loop back into the picker; only
  // `checkout` and `cancel` exit.
  while (true) {
    const choices = buildBranchChoices({
      validBranches,
      currentBranch,
      regions,
      overview,
      noColor,
    });
    const outcome = await branchPickerPrompt({
      message: 'Checkout a branch (autocomplete or arrow keys)',
      choices,
      defaultBranch,
      footer: footerParts.join('\n') || undefined,
      noColor,
    });
    const next = await handlePickerOutcome(outcome, state, cwd, stylers);
    if ('done' in next) return next.done;
    defaultBranch = next.continueWith;
  }
}
