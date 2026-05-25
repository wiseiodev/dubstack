import { DubError } from './errors';
import { getDescendants } from './graph';
import { assertStateInvariants } from './invariants';
import { findStackForBranch, readState, type Stack, writeState } from './state';

export interface UntrackOptions {
  branch: string;
  downstack?: boolean;
  dryRun?: boolean;
}

export interface UntrackResult {
  removed: string[];
  reparented: Array<{ branch: string; parent: string | null }>;
  dryRun: boolean;
}

export interface UntrackContext {
  stack: Stack;
  branch: string;
  descendants: string[];
}

export async function getUntrackContext(
  cwd: string,
  branch: string,
): Promise<UntrackContext> {
  const state = await readState(cwd);
  const stack = findStackForBranch(state, branch);
  if (!stack) {
    throw new DubError(`Branch '${branch}' is not tracked.`, [
      `Run 'dub track ${branch} --parent <branch>' to track it.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }
  return {
    stack,
    branch,
    descendants: getDescendants(stack, branch),
  };
}

/**
 * Removes a branch from DubStack tracking metadata without deleting git branches.
 */
export async function untrackBranch(
  cwd: string,
  options: UntrackOptions,
): Promise<UntrackResult> {
  const state = await readState(cwd);
  const stack = findStackForBranch(state, options.branch);
  if (!stack) {
    throw new DubError(
      `Branch '${options.branch}' is not tracked by DubStack.`,
      [
        `Run 'dub track ${options.branch} --parent <branch>' to track it.`,
        "Run 'dub log' to see currently tracked branches.",
      ],
    );
  }

  const entry = stack.branches.find((branch) => branch.name === options.branch);
  if (!entry) {
    throw new DubError(
      `Branch '${options.branch}' is missing from tracked stack.`,
      ["Run 'dub doctor' to inspect the stack for metadata damage."],
    );
  }

  const descendants = getDescendants(stack, options.branch);
  const removedSet = new Set<string>(
    options.downstack ? [options.branch, ...descendants] : [options.branch],
  );

  if (entry.type === 'root' && !options.downstack && descendants.length > 0) {
    throw new DubError(
      `Branch '${options.branch}' is a root with descendants.`,
      [
        `Rerun 'dub untrack ${options.branch} --downstack' to untrack the whole subtree.`,
        `Run 'dub track <descendant> --parent <other>' to move descendants off this root first.`,
      ],
    );
  }

  const reparented: Array<{ branch: string; parent: string | null }> = [];
  if (!options.downstack) {
    for (const branch of stack.branches) {
      if (branch.parent !== options.branch) continue;
      branch.parent = entry.parent;
      reparented.push({ branch: branch.name, parent: branch.parent });
    }
  }

  stack.branches = stack.branches.filter(
    (branch) => !removedSet.has(branch.name),
  );
  state.stacks = state.stacks.filter(
    (candidate) => candidate.branches.length > 0,
  );

  assertStateInvariants(state.stacks);
  const dryRun = options.dryRun ?? false;
  if (!dryRun) await writeState(state, cwd);

  return {
    removed: [options.branch, ...(options.downstack ? descendants : [])],
    reparented,
    dryRun,
  };
}
