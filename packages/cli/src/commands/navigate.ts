import { DubError } from '../lib/errors';
import { checkoutBranch, getCurrentBranch } from '../lib/git';
import { findStackForBranch, readState, type Stack } from '../lib/state';

interface NavigateResult {
  branch: string;
  changed: boolean;
}

function getBranchByName(stack: Stack, name: string) {
  return stack.branches.find((branch) => branch.name === name);
}

function getChildren(stack: Stack, parent: string): string[] {
  return stack.branches
    .filter((branch) => branch.parent === parent)
    .map((branch) => branch.name);
}

function getTrackedStackOrThrow(
  stateBranch: string,
  stack: Stack | undefined,
): Stack {
  if (!stack) {
    throw new DubError(
      `Current branch '${stateBranch}' is not tracked by DubStack.`,
      [
        `Run 'dub track ${stateBranch} --parent <branch>' to track it.`,
        "Run 'dub log' to see currently tracked branches.",
      ],
    );
  }
  return stack;
}

/**
 * Checkout the direct child branch of the current branch.
 * Requires a linear stack path.
 */
export async function up(cwd: string): Promise<NavigateResult> {
  return upBySteps(cwd, 1);
}

/**
 * Checkout the child branch of the current branch by N steps.
 * Requires a linear stack path.
 */
export async function upBySteps(
  cwd: string,
  steps: number,
): Promise<NavigateResult> {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new DubError("'steps' must be a positive integer.", [
      "Pass '<n>' or '--steps <n>' as a positive integer (e.g. 'dub up 2').",
    ]);
  }

  const state = await readState(cwd);
  const current = await getCurrentBranch(cwd);
  const stack = getTrackedStackOrThrow(
    current,
    findStackForBranch(state, current),
  );

  let target = current;
  for (let i = 0; i < steps; i++) {
    const children = getChildren(stack, target);
    if (children.length === 0) {
      throw new DubError(`No branch above '${target}' in the current stack.`, [
        "Run 'dub create <branch>' to add a new branch above this one.",
        "Run 'dub log' to inspect the stack and confirm there is no upstack branch.",
      ]);
    }
    if (children.length > 1) {
      throw new DubError(
        `Branch '${target}' has multiple children; 'dub up' requires a linear stack path.`,
        [
          "Run 'dub checkout <child>' to switch to the specific child branch.",
          "Run 'dub log' to see all upstack branches.",
        ],
      );
    }
    target = children[0];
  }

  await checkoutBranch(target, cwd);
  return { branch: target, changed: target !== current };
}

/**
 * Checkout the direct parent branch of the current branch.
 */
export async function down(cwd: string): Promise<NavigateResult> {
  return downBySteps(cwd, 1);
}

/**
 * Checkout the parent branch of the current branch by N steps.
 */
export async function downBySteps(
  cwd: string,
  steps: number,
): Promise<NavigateResult> {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new DubError("'steps' must be a positive integer.", [
      "Pass '<n>' or '--steps <n>' as a positive integer (e.g. 'dub up 2').",
    ]);
  }

  const state = await readState(cwd);
  const current = await getCurrentBranch(cwd);
  const stack = getTrackedStackOrThrow(
    current,
    findStackForBranch(state, current),
  );
  let target = current;
  for (let i = 0; i < steps; i++) {
    const branch = getBranchByName(stack, target);
    if (!branch) {
      throw new DubError(
        `Current branch '${target}' is not tracked by DubStack.`,
        [
          `Run 'dub track ${target} --parent <branch>' to track it.`,
          "Run 'dub log' to see currently tracked branches.",
        ],
      );
    }
    if (!branch.parent) {
      throw new DubError(
        `Already at the bottom of the stack (root branch '${target}').`,
        [
          "Run 'dub up' to move back to a non-root branch.",
          "Run 'dub log' to see the stack layout.",
        ],
      );
    }
    target = branch.parent;
  }

  await checkoutBranch(target, cwd);
  return { branch: target, changed: target !== current };
}

/**
 * Checkout the topmost descendant reachable by following a single-child path.
 */
export async function top(cwd: string): Promise<NavigateResult> {
  const state = await readState(cwd);
  const current = await getCurrentBranch(cwd);
  const stack = getTrackedStackOrThrow(
    current,
    findStackForBranch(state, current),
  );

  let target = current;
  while (true) {
    const children = getChildren(stack, target);
    if (children.length === 0) break;
    if (children.length > 1) {
      throw new DubError(
        `Branch '${target}' has multiple children; 'dub top' requires a linear stack path.`,
        [
          "Run 'dub checkout <child>' to switch to the specific child branch.",
          "Run 'dub log' to see all upstack branches.",
        ],
      );
    }
    target = children[0];
  }

  if (target !== current) {
    await checkoutBranch(target, cwd);
  }
  return { branch: target, changed: target !== current };
}

/**
 * Checkout the first branch above the root for the current stack path.
 */
export async function bottom(cwd: string): Promise<NavigateResult> {
  const state = await readState(cwd);
  const current = await getCurrentBranch(cwd);
  const stack = getTrackedStackOrThrow(
    current,
    findStackForBranch(state, current),
  );
  const branch = getBranchByName(stack, current);

  if (!branch) {
    throw new DubError(
      `Current branch '${current}' is not tracked by DubStack.`,
      [
        `Run 'dub track ${current} --parent <branch>' to track it.`,
        "Run 'dub log' to see currently tracked branches.",
      ],
    );
  }

  let target = current;
  if (!branch.parent) {
    const children = getChildren(stack, current);
    if (children.length === 0) {
      throw new DubError(
        `No branch above root '${current}' in the current stack.`,
        ["Run 'dub create <branch>' to add a branch above the root."],
      );
    }
    if (children.length > 1) {
      throw new DubError(
        `Root branch '${current}' has multiple children; 'dub bottom' requires a linear stack path.`,
        [
          "Run 'dub checkout <child>' to switch to a specific child branch.",
          "Run 'dub log' to see all branches above the root.",
        ],
      );
    }
    target = children[0];
  } else {
    let node = branch;
    while (node.parent) {
      const parent = getBranchByName(stack, node.parent);
      if (!parent) {
        break;
      }
      if (parent.parent === null) {
        target = node.name;
        break;
      }
      node = parent;
    }
  }

  if (target !== current) {
    await checkoutBranch(target, cwd);
  }
  return { branch: target, changed: target !== current };
}
