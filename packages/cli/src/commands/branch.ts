import { getCurrentBranch, getDiffBetween } from '../lib/git';
import { findStackForBranch, readState, type Stack } from '../lib/state';

/** Position of the current branch in a tree-shaped stack. */
export interface TreePosition {
  /** Parent of the current branch (root or another branch). */
  parent: string;
  /** 1-based index of the current branch among its siblings (alphabetical). */
  siblingIndex: number;
  /** Total siblings under the parent, including the current branch. */
  siblingCount: number;
  /** Number of descendants of the current branch (transitive). */
  descendantCount: number;
}

export interface BranchInfoResult {
  currentBranch: string;
  tracked: boolean;
  stackId: string | null;
  root: string | null;
  parent: string | null;
  children: string[];
  treePosition: TreePosition | null;
}

function findRootName(stack: Stack): string | null {
  return stack.branches.find((branch) => branch.type === 'root')?.name ?? null;
}

function getChildren(stack: Stack, branchName: string): string[] {
  return stack.branches
    .filter((branch) => branch.parent === branchName)
    .map((branch) => branch.name)
    .sort();
}

function countDescendants(stack: Stack, branchName: string): number {
  const childMap = new Map<string, string[]>();
  for (const b of stack.branches) {
    if (b.parent) {
      const kids = childMap.get(b.parent) ?? [];
      kids.push(b.name);
      childMap.set(b.parent, kids);
    }
  }
  const visited = new Set<string>();
  const queue = [...(childMap.get(branchName) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    queue.push(...(childMap.get(next) ?? []));
  }
  return visited.size;
}

function stackHasBranching(stack: Stack): boolean {
  const counts = new Map<string, number>();
  for (const b of stack.branches) {
    if (b.parent) {
      counts.set(b.parent, (counts.get(b.parent) ?? 0) + 1);
    }
  }
  for (const n of counts.values()) {
    if (n >= 2) return true;
  }
  return false;
}

function computeTreePosition(
  stack: Stack,
  branchName: string,
): TreePosition | null {
  const current = stack.branches.find((b) => b.name === branchName);
  if (!current || !current.parent) return null;

  const siblings = getChildren(stack, current.parent);
  const descendantCount = countDescendants(stack, branchName);

  if (
    siblings.length <= 1 &&
    descendantCount === 0 &&
    !stackHasBranching(stack)
  ) {
    return null;
  }

  const siblingIndex = siblings.indexOf(branchName) + 1;
  return {
    parent: current.parent,
    siblingIndex,
    siblingCount: siblings.length,
    descendantCount,
  };
}

/**
 * Returns tracked branch metadata for the current branch.
 */
export async function branchInfo(
  cwd: string,
  branchName?: string,
): Promise<BranchInfoResult> {
  const state = await readState(cwd);
  const resolvedBranch = branchName ?? (await getCurrentBranch(cwd));
  const stack = findStackForBranch(state, resolvedBranch);

  if (!stack) {
    return {
      currentBranch: resolvedBranch,
      tracked: false,
      stackId: null,
      root: null,
      parent: null,
      children: [],
      treePosition: null,
    };
  }

  const current = stack.branches.find(
    (branch) => branch.name === resolvedBranch,
  );

  return {
    currentBranch: resolvedBranch,
    tracked: true,
    stackId: stack.id,
    root: findRootName(stack),
    parent: current?.parent ?? null,
    children: getChildren(stack, resolvedBranch),
    treePosition: computeTreePosition(stack, resolvedBranch),
  };
}

/**
 * Formats branch info in a human-readable layout.
 */
export function formatBranchInfo(info: BranchInfoResult): string {
  if (!info.tracked) {
    return [
      `Branch: ${info.currentBranch}`,
      'Tracked: no',
      'Status: not tracked by DubStack',
    ].join('\n');
  }

  const childrenLabel =
    info.children.length > 0 ? info.children.join(', ') : '(none)';
  const lines = [
    `Branch: ${info.currentBranch}`,
    'Tracked: yes',
    `Stack ID: ${info.stackId ?? '(unknown)'}`,
    `Root: ${info.root ?? '(unknown)'}`,
    `Parent: ${info.parent ?? '(root)'}`,
    `Children: ${childrenLabel}`,
  ];
  if (info.treePosition) {
    const { parent, siblingIndex, siblingCount, descendantCount } =
      info.treePosition;
    const descendantLabel =
      descendantCount === 1 ? '1 descendant' : `${descendantCount} descendants`;
    lines.push(
      `On ${info.currentBranch} (${siblingIndex} of ${siblingCount} siblings under ${parent}, ${descendantLabel}).`,
    );
  }
  return lines.join('\n');
}

export interface BranchInfoOutputOptions {
  diff?: boolean;
}

/**
 * Formats branch info and optionally appends a parent-relative git diff.
 */
export async function branchInfoOutput(
  cwd: string,
  branchName?: string,
  options: BranchInfoOutputOptions = {},
): Promise<string> {
  const info = await branchInfo(cwd, branchName);
  const summary = formatBranchInfo(info);

  if (!options.diff) {
    return summary;
  }

  if (!info.tracked) {
    return [
      summary,
      '',
      'Diff: unavailable because this branch is not tracked by DubStack.',
    ].join('\n');
  }

  if (!info.parent) {
    return [summary, '', 'Diff: unavailable for stack root branches.'].join(
      '\n',
    );
  }

  const diff = await getDiffBetween(info.parent, info.currentBranch, cwd);
  return [
    summary,
    '',
    `Diff vs ${info.parent}:`,
    diff.trim().length > 0 ? diff.trimEnd() : '(no changes)',
  ].join('\n');
}
