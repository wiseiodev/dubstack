import chalk, { Chalk, type ChalkInstance } from 'chalk';
import { DubError } from '../lib/errors';
import { branchExists, getCurrentBranch } from '../lib/git';
import type { BranchOverview, StackOverview } from '../lib/stack-overview';
import type { Branch, Stack } from '../lib/state';
import { findStackForBranch, readState } from '../lib/state';

interface LogOptions {
  stack?: boolean;
  all?: boolean;
  reverse?: boolean;
  /** Render PR-state annotations when overview data is present (default true). */
  prs?: boolean;
  /** Render CI-state annotations when overview data is present (default true). */
  ci?: boolean;
  /** Disable ANSI codes in rich-suffix annotations. */
  noColor?: boolean;
  /**
   * Pre-fetched stack overview joining PR + commit metadata. When absent,
   * `log()` falls back to the plain region-only tree. The CLI fetches this
   * via {@link getStackOverviewBatch} and fails soft when `gh` is unauthed.
   */
  overview?: StackOverview | null;
}

export type LogRegion =
  | 'root'
  | 'ancestor'
  | 'current'
  | 'descendant'
  | 'sibling-subtree';

export interface LogJsonBranch {
  name: string;
  type: 'root' | 'branch';
  parent: string | null;
  current: boolean;
  exists: boolean;
  prNumber: number | null;
  prLink: string | null;
  region: LogRegion;
  children: LogJsonBranch[];
  // Rich-overview fields (only present when overview data is available).
  prState?: 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE';
  prTitle?: string;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  ciState?: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
  draft?: boolean;
  committedRel?: string;
  shortSha?: string;
  /** Reserved for DUB-37 (`dub freeze`); always undefined today. */
  frozen?: boolean;
}

export interface LogJsonStack {
  id: string;
  root: LogJsonBranch | null;
}

export interface LogJsonResult {
  currentBranch: string | null;
  stacks: LogJsonStack[];
  /**
   * Mirrors {@link StackOverview.truncated} when an overview was provided.
   * Callers can surface a "showing N of N+" notice.
   */
  overviewTruncated?: boolean;
}

/**
 * Renders an ASCII tree view of all tracked stacks.
 *
 * Highlights the current branch, marks branches missing from git,
 * and handles multiple stacks separated by blank lines.
 *
 * Output uses inline markers consumed by {@link styleLogOutput}:
 *   `*name (Current)*` — current branch
 *   `>name`            — ancestor on the current path
 *   `~name~`           — branch in a sibling sub-tree
 *   `name ⚠ (missing)` — branch missing from git (composes with the above)
 *
 * Branch names cannot contain `*`, `>`, `~`, or whitespace per git refname
 * rules, so the markers cannot collide with branch text.
 *
 * When `options.overview` is provided, rich-suffix annotations (PR state,
 * CI rollup, last-commit relative time, short SHA) are appended to each
 * branch label. Suffix coloring is applied directly via a chalk instance
 * scoped to `options.noColor` so it bypasses {@link styleLogOutput}.
 *
 * @param cwd - Working directory (must be inside an initialized dubstack repo)
 * @returns Formatted ASCII tree string (suffix ANSI applied; primary markers added later)
 * @throws {DubError} If not initialized
 */
export async function log(
  cwd: string,
  options: LogOptions = {},
): Promise<string> {
  const state = await readState(cwd);

  if (state.stacks.length === 0) {
    return "No stacks. Run 'dub create' to start.";
  }

  const currentBranch = await resolveCurrentBranch(cwd);
  let stacksToRender = selectStacksToRender(state, currentBranch, options);
  if (options.reverse) {
    stacksToRender = [...stacksToRender].reverse();
  }

  const overviewMap = buildOverviewMap(options.overview);
  const suffixChalk = makeSuffixChalk(options.noColor === true);

  const sections: string[] = [];

  for (const stack of stacksToRender) {
    const tree = await renderStack(
      stack,
      currentBranch,
      cwd,
      options,
      overviewMap,
      suffixChalk,
    );
    sections.push(tree);
  }

  return sections.join('\n\n');
}

export async function logJson(
  cwd: string,
  options: LogOptions = {},
): Promise<LogJsonResult> {
  const state = await readState(cwd);
  const currentBranch = await resolveCurrentBranch(cwd);
  let stacksToRender = selectStacksToRender(state, currentBranch, options);
  if (options.reverse) {
    stacksToRender = [...stacksToRender].reverse();
  }

  const overviewMap = buildOverviewMap(options.overview);

  const stacks: LogJsonStack[] = [];
  for (const stack of stacksToRender) {
    stacks.push({
      id: stack.id,
      root: await renderStackJson(
        stack,
        currentBranch,
        cwd,
        options,
        overviewMap,
      ),
    });
  }

  const result: LogJsonResult = { currentBranch, stacks };
  if (options.overview) {
    result.overviewTruncated = options.overview.truncated;
  }
  return result;
}

async function resolveCurrentBranch(cwd: string): Promise<string | null> {
  try {
    return await getCurrentBranch(cwd);
  } catch {
    // Detached HEAD or empty repo — no branch highlighted
    return null;
  }
}

function selectStacksToRender(
  state: { stacks: Stack[] },
  currentBranch: string | null,
  options: LogOptions,
): Stack[] {
  if (!(options.stack && !options.all)) {
    return state.stacks;
  }
  if (!currentBranch) {
    throw new DubError('Cannot determine current branch for --stack mode.', [
      "Run 'dub checkout <branch>' to attach HEAD to a branch.",
      "Rerun 'dub log --all' to render every tracked stack instead.",
    ]);
  }
  const currentStack = findStackForBranch(state, currentBranch);
  if (!currentStack) {
    throw new DubError(`Current branch '${currentBranch}' is not tracked.`, [
      `Run 'dub track ${currentBranch} --parent <branch>' to track it.`,
      "Rerun 'dub log --all' to render every tracked stack instead.",
    ]);
  }
  return [currentStack];
}

/**
 * Tags each branch in the stack with its region relative to the current branch.
 *
 * Regions:
 *   - `root`            — stack trunk (always); takes precedence over other regions
 *   - `current`         — the current branch (when also the root, region stays `root`;
 *                         callers should consult `current: boolean` to identify the
 *                         current branch on the trunk)
 *   - `ancestor`        — branch on the current branch's parent path (excluding root)
 *   - `descendant`      — any descendant of the current branch
 *   - `sibling-subtree` — everything else (siblings of any ancestor and their descendants)
 *
 * When the current branch is not in this stack, every non-root branch is reported
 * as `descendant` so no region styling is applied.
 *
 * The walk is cycle-safe via per-direction visited sets; a malformed parent loop
 * in state cannot hang the command.
 */
export function computeRegions(
  stack: Stack,
  currentBranch: string | null,
): Map<string, LogRegion> {
  const regions = new Map<string, LogRegion>();
  const parentMap = new Map<string, string | null>();
  const childMap = new Map<string, string[]>();

  for (const b of stack.branches) {
    parentMap.set(b.name, b.parent);
    if (b.parent) {
      const kids = childMap.get(b.parent) ?? [];
      kids.push(b.name);
      childMap.set(b.parent, kids);
    }
  }

  for (const b of stack.branches) {
    regions.set(b.name, b.type === 'root' ? 'root' : 'sibling-subtree');
  }

  if (!currentBranch || !regions.has(currentBranch)) {
    for (const b of stack.branches) {
      if (b.type !== 'root') regions.set(b.name, 'descendant');
    }
    return regions;
  }

  if (regions.get(currentBranch) !== 'root') {
    regions.set(currentBranch, 'current');
  }

  const visitedAncestors = new Set<string>();
  let cursor = parentMap.get(currentBranch) ?? null;
  while (cursor && !visitedAncestors.has(cursor)) {
    visitedAncestors.add(cursor);
    // Preserve `root` and `current` if a malformed parent cycle leads the walk
    // back to the current branch itself.
    const existing = regions.get(cursor);
    if (existing !== 'root' && existing !== 'current') {
      regions.set(cursor, 'ancestor');
    }
    cursor = parentMap.get(cursor) ?? null;
  }

  const visitedDescendants = new Set<string>();
  const queue = [...(childMap.get(currentBranch) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visitedDescendants.has(next)) continue;
    visitedDescendants.add(next);
    // Only overwrite the default `sibling-subtree` classification; preserve
    // `root`, `current`, and `ancestor` if a malformed parent cycle leads the
    // BFS back into them.
    if (regions.get(next) === 'sibling-subtree') {
      regions.set(next, 'descendant');
    }
    queue.push(...(childMap.get(next) ?? []));
  }

  return regions;
}

async function renderStack(
  stack: Stack,
  currentBranch: string | null,
  cwd: string,
  options: LogOptions,
  overviewMap: Map<string, BranchOverview>,
  suffixChalk: ChalkInstance,
): Promise<string> {
  const root = stack.branches.find((b) => b.type === 'root');
  if (!root) return '';

  const childMap = new Map<string, Branch[]>();
  for (const branch of stack.branches) {
    if (branch.parent) {
      const children = childMap.get(branch.parent) ?? [];
      children.push(branch);
      childMap.set(branch.parent, children);
    }
  }

  const regions = computeRegions(stack, currentBranch);

  const lines: string[] = [];
  await renderNode(
    root,
    currentBranch,
    childMap,
    regions,
    '',
    true,
    true,
    lines,
    cwd,
    options,
    overviewMap,
    suffixChalk,
  );
  return lines.join('\n');
}

async function renderStackJson(
  stack: Stack,
  currentBranch: string | null,
  cwd: string,
  options: LogOptions,
  overviewMap: Map<string, BranchOverview>,
): Promise<LogJsonBranch | null> {
  const root = stack.branches.find((b) => b.type === 'root');
  if (!root) return null;

  const childMap = new Map<string, Branch[]>();
  for (const branch of stack.branches) {
    if (branch.parent) {
      const children = childMap.get(branch.parent) ?? [];
      children.push(branch);
      childMap.set(branch.parent, children);
    }
  }

  const regions = computeRegions(stack, currentBranch);

  return renderNodeJson(
    root,
    currentBranch,
    childMap,
    regions,
    cwd,
    options,
    overviewMap,
  );
}

async function renderNodeJson(
  branch: Branch,
  currentBranch: string | null,
  childMap: Map<string, Branch[]>,
  regions: Map<string, LogRegion>,
  cwd: string,
  options: LogOptions,
  overviewMap: Map<string, BranchOverview>,
): Promise<LogJsonBranch> {
  const children = options.reverse
    ? [...(childMap.get(branch.name) ?? [])].reverse()
    : (childMap.get(branch.name) ?? []);

  const node: LogJsonBranch = {
    name: branch.name,
    type: branch.type === 'root' ? 'root' : 'branch',
    parent: branch.parent,
    current: branch.name === currentBranch,
    exists: await branchExists(branch.name, cwd),
    prNumber: branch.pr_number,
    prLink: branch.pr_link,
    region: regions.get(branch.name) ?? 'descendant',
    children: await Promise.all(
      children.map((child) =>
        renderNodeJson(
          child,
          currentBranch,
          childMap,
          regions,
          cwd,
          options,
          overviewMap,
        ),
      ),
    ),
  };

  const overview = overviewMap.get(branch.name);
  if (overview) {
    if (overview.pr) {
      node.prState = overview.pr.state;
      node.prTitle = overview.pr.title;
      node.reviewDecision = normalizeReviewDecision(overview.pr.reviewDecision);
      node.ciState = overview.pr.ciRollup;
      node.draft = overview.pr.isDraft;
    } else {
      node.prState = 'NONE';
      node.ciState = 'NONE';
      node.draft = false;
      node.reviewDecision = null;
    }
    if (overview.commit) {
      node.committedRel = overview.commit.committedRel;
      node.shortSha = overview.commit.shortSha;
    }
  }

  return node;
}

async function renderNode(
  branch: Branch,
  currentBranch: string | null,
  childMap: Map<string, Branch[]>,
  regions: Map<string, LogRegion>,
  prefix: string,
  isRoot: boolean,
  isLast: boolean,
  lines: string[],
  cwd: string,
  options: LogOptions,
  overviewMap: Map<string, BranchOverview>,
  suffixChalk: ChalkInstance,
): Promise<void> {
  let label: string;
  const exists = await branchExists(branch.name, cwd);
  const region = regions.get(branch.name) ?? 'descendant';

  if (isRoot) {
    label = `(${branch.name})`;
  } else if (branch.name === currentBranch) {
    label = `*${branch.name} (Current)*`;
  } else {
    if (region === 'ancestor') {
      label = `>${branch.name}`;
    } else if (region === 'sibling-subtree') {
      label = `~${branch.name}~`;
    } else {
      label = branch.name;
    }
    if (!exists) {
      label = `${label} ⚠ (missing)`;
    }
  }

  const overview = overviewMap.get(branch.name);
  if (overview) {
    const suffix = formatRichSuffix(overview, options, suffixChalk);
    if (suffix) {
      label = `${label}  ${suffix}`;
    }
  }

  if (isRoot) {
    lines.push(label);
  } else {
    const connector = isLast ? '└─ ' : '├─ ';
    lines.push(`${prefix}${connector}${label}`);
  }

  const children = options.reverse
    ? [...(childMap.get(branch.name) ?? [])].reverse()
    : (childMap.get(branch.name) ?? []);
  const childPrefix = isRoot ? '  ' : `${prefix}${isLast ? '     ' : '│    '}`;

  for (let i = 0; i < children.length; i++) {
    const isChildLast = i === children.length - 1;
    await renderNode(
      children[i],
      currentBranch,
      childMap,
      regions,
      childPrefix,
      false,
      isChildLast,
      lines,
      cwd,
      options,
      overviewMap,
      suffixChalk,
    );
  }
}

/**
 * Applies CLI styling to the marker-tagged output produced by {@link log}.
 *
 * When `noColor` is true (explicit `--no-color`, `NO_COLOR=1`, or no TTY),
 * the `~name~` sibling markers are stripped while `*name (Current)*` and
 * `>name` are kept as plain-text indicators per the DUB-77 spec. When
 * `noColor` is false, all markers are replaced with chalk-styled output.
 *
 * Rich-suffix annotations are styled by {@link log} directly via the chalk
 * instance it builds from `LogOptions.noColor`, so this helper leaves them
 * alone.
 *
 * Exported for unit testing — callers should use {@link log} + this helper
 * rather than rolling their own regex.
 */
export function styleLogOutput(output: string, noColor: boolean): string {
  if (noColor) {
    return output.replace(/~([^~]+?)~/g, '$1');
  }
  return output
    .replace(/\*(.+?) \(Current\)\*/g, chalk.bold.cyan('$1 (Current)'))
    .replace(/(─ )>(\S+)/g, `$1${chalk.bold('$2')}`)
    .replace(/~([^~]+?)~/g, chalk.dim('$1'))
    .replace(/⚠ \(missing\)/g, chalk.yellow('⚠ (missing)'));
}

function buildOverviewMap(
  overview: StackOverview | null | undefined,
): Map<string, BranchOverview> {
  const map = new Map<string, BranchOverview>();
  if (!overview) return map;
  for (const entry of overview.branches) {
    map.set(entry.branch, entry);
  }
  return map;
}

function makeSuffixChalk(noColor: boolean): ChalkInstance {
  // A scoped chalk instance keeps the suffix styling decision local to
  // `log()` so callers don't have to mutate the global chalk.level (which
  // would race with concurrent renders and leak across vitest cases).
  if (noColor) return new Chalk({ level: 0 });
  return chalk;
}

function normalizeReviewDecision(
  decision: string | null,
): 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null {
  if (
    decision === 'APPROVED' ||
    decision === 'CHANGES_REQUESTED' ||
    decision === 'REVIEW_REQUIRED'
  ) {
    return decision;
  }
  return null;
}

/**
 * Builds the rich-suffix annotation appended to a branch label. Returns an
 * empty string when the overview has nothing to surface for this branch
 * (PR + CI suppressed by flags, no commit metadata).
 */
function formatRichSuffix(
  overview: BranchOverview,
  options: LogOptions,
  c: ChalkInstance,
): string {
  const parts: string[] = [];
  const includePrs = options.prs !== false;
  const includeCi = options.ci !== false;

  if (includePrs && overview.pr) {
    const prToken = formatPrToken(overview.pr, c);
    if (prToken) parts.push(prToken);
  }
  if (includeCi && overview.pr) {
    const ciToken = formatCiToken(overview.pr.ciRollup, c);
    if (ciToken) parts.push(ciToken);
  }
  if (overview.commit) {
    parts.push(c.dim(overview.commit.committedRel));
    parts.push(c.dim(overview.commit.shortSha));
  }

  return parts.join(c.dim(' · '));
}

function formatPrToken(
  pr: NonNullable<BranchOverview['pr']>,
  c: ChalkInstance,
): string {
  const prefix = `#${pr.number}`;
  // Draft trumps approval glyphs — we want to surface "not ready to review"
  // even when CODEOWNERS have already left an approval on an earlier push.
  if (pr.state === 'MERGED') {
    return `${c.dim(prefix)} ${c.magenta('⤓ merged')}`;
  }
  if (pr.state === 'CLOSED') {
    return `${c.dim(prefix)} ${c.dim('⊘ closed')}`;
  }
  if (pr.isDraft) {
    return `${c.dim(prefix)} ${c.dim('✏ draft')}`;
  }
  if (pr.reviewDecision === 'APPROVED') {
    return `${c.dim(prefix)} ${c.green('✔ approved')}`;
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return `${c.dim(prefix)} ${c.red('✗ changes requested')}`;
  }
  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    return `${c.dim(prefix)} ${c.yellow('⏳ review pending')}`;
  }
  // Open PR with no review decision yet — surface the bare number so users
  // can see a PR exists, but don't fake a review state.
  return `${c.dim(prefix)} ${c.dim('open')}`;
}

function formatCiToken(
  rollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE',
  c: ChalkInstance,
): string {
  switch (rollup) {
    case 'SUCCESS':
      return c.green('✔ ci');
    case 'FAILURE':
      return c.red('✗ ci');
    case 'PENDING':
      return c.yellow('⏳ ci');
    case 'NONE':
      // Suppress the "− ci" glyph when there are no checks at all — most
      // branches without checks aren't interesting to call out.
      return '';
  }
}
