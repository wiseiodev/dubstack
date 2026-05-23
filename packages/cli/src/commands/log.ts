import { DubError } from '../lib/errors';
import { branchExists, getCurrentBranch } from '../lib/git';
import type { Branch, Stack } from '../lib/state';
import { findStackForBranch, readState } from '../lib/state';

interface LogOptions {
  stack?: boolean;
  all?: boolean;
  reverse?: boolean;
}

export interface LogJsonBranch {
  name: string;
  type: 'root' | 'branch';
  parent: string | null;
  current: boolean;
  exists: boolean;
  prNumber: number | null;
  prLink: string | null;
  children: LogJsonBranch[];
}

export interface LogJsonStack {
  id: string;
  root: LogJsonBranch | null;
}

export interface LogJsonResult {
  currentBranch: string | null;
  stacks: LogJsonStack[];
}

/**
 * Renders an ASCII tree view of all tracked stacks.
 *
 * Highlights the current branch, marks branches missing from git,
 * and handles multiple stacks separated by blank lines.
 *
 * @param cwd - Working directory (must be inside an initialized dubstack repo)
 * @returns Formatted ASCII tree string (no ANSI colors — caller adds chalk)
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

  const sections: string[] = [];

  for (const stack of stacksToRender) {
    const tree = await renderStack(stack, currentBranch, cwd, options);
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

  const stacks: LogJsonStack[] = [];
  for (const stack of stacksToRender) {
    stacks.push({
      id: stack.id,
      root: await renderStackJson(stack, currentBranch, cwd, options),
    });
  }

  return { currentBranch, stacks };
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

async function renderStack(
  stack: Stack,
  currentBranch: string | null,
  cwd: string,
  options: LogOptions,
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

  const lines: string[] = [];
  await renderNode(
    root,
    currentBranch,
    childMap,
    '',
    true,
    true,
    lines,
    cwd,
    options,
  );
  return lines.join('\n');
}

async function renderStackJson(
  stack: Stack,
  currentBranch: string | null,
  cwd: string,
  options: LogOptions,
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

  return renderNodeJson(root, currentBranch, childMap, cwd, options);
}

async function renderNodeJson(
  branch: Branch,
  currentBranch: string | null,
  childMap: Map<string, Branch[]>,
  cwd: string,
  options: LogOptions,
): Promise<LogJsonBranch> {
  const children = options.reverse
    ? [...(childMap.get(branch.name) ?? [])].reverse()
    : (childMap.get(branch.name) ?? []);

  return {
    name: branch.name,
    type: branch.type === 'root' ? 'root' : 'branch',
    parent: branch.parent,
    current: branch.name === currentBranch,
    exists: await branchExists(branch.name, cwd),
    prNumber: branch.pr_number,
    prLink: branch.pr_link,
    children: await Promise.all(
      children.map((child) =>
        renderNodeJson(child, currentBranch, childMap, cwd, options),
      ),
    ),
  };
}

async function renderNode(
  branch: Branch,
  currentBranch: string | null,
  childMap: Map<string, Branch[]>,
  prefix: string,
  isRoot: boolean,
  isLast: boolean,
  lines: string[],
  cwd: string,
  options: LogOptions,
): Promise<void> {
  let label: string;
  const exists = await branchExists(branch.name, cwd);

  if (isRoot) {
    label = `(${branch.name})`;
  } else if (branch.name === currentBranch) {
    label = `*${branch.name} (Current)*`;
  } else if (!exists) {
    label = `${branch.name} ⚠ (missing)`;
  } else {
    label = branch.name;
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
      childPrefix,
      false,
      isChildLast,
      lines,
      cwd,
      options,
    );
  }
}
