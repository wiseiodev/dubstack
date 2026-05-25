import * as crypto from 'node:crypto';
import { DubError } from './errors';
import { branchExists } from './git';
import { getDescendants } from './graph';
import { assertStateInvariants } from './invariants';
import {
  addBranchToStack,
  type DubState,
  ensureConfiguredTrunk,
  ensureState,
  findStackForBranch,
  getStackTrunk,
  readStateForDryRun,
  writeState,
} from './state';

export interface TrackBranchOptions {
  branch: string;
  parent: string;
  dryRun?: boolean;
}

export interface TrackBranchResult {
  branch: string;
  parent: string;
  status: 'tracked' | 'reparented' | 'unchanged';
  dryRun: boolean;
}

export async function validateTrackParent(
  cwd: string,
  branch: string,
  parent: string,
): Promise<void> {
  if (branch === parent) {
    throw new DubError('Branch cannot be its own parent.', [
      'Pick a different parent branch and retry.',
    ]);
  }
  if (!(await branchExists(parent, cwd))) {
    throw new DubError(`Parent branch '${parent}' does not exist locally.`, [
      `Run 'git fetch && git checkout ${parent}' to fetch the parent first.`,
      "Run 'dub log' to see existing tracked branches.",
    ]);
  }
}

/**
 * Tracks an existing local branch or updates its parent relationship.
 */
export async function trackBranch(
  cwd: string,
  options: TrackBranchOptions,
): Promise<TrackBranchResult> {
  const { branch, parent } = options;
  const dryRun = options.dryRun ?? false;
  if (!(await branchExists(branch, cwd))) {
    throw new DubError(`Branch '${branch}' does not exist locally.`, [
      `Run 'git checkout -b ${branch}' to create the branch first.`,
      `Run 'git fetch && git checkout ${branch}' to pull it from the remote.`,
    ]);
  }
  await validateTrackParent(cwd, branch, parent);

  // Dry-run must never create state on disk but must surface corruption /
  // IO errors that a real run would hit. `readStateForDryRun` narrows the
  // fallback to the "not initialized" case only.
  const state: DubState = dryRun
    ? await readStateForDryRun(cwd)
    : await ensureState(cwd);
  const sourceStack = findStackForBranch(state, branch);
  const destinationStack = findStackForBranch(state, parent);

  if (!sourceStack) {
    addBranchToStack(state, branch, parent);
    assertStateInvariants(state.stacks);
    if (!dryRun) await writeState(state, cwd);
    return { branch, parent, status: 'tracked', dryRun };
  }

  const branchEntry = sourceStack.branches.find(
    (entry) => entry.name === branch,
  );
  if (!branchEntry) {
    throw new DubError(`Branch '${branch}' is missing from tracked state.`, [
      "Run 'dub doctor' to inspect tracked state for damage.",
      `Run 'dub track ${branch} --parent <branch>' to re-add it explicitly.`,
    ]);
  }
  if (branchEntry.type === 'root') {
    throw new DubError(
      `Branch '${branch}' is a stack root and cannot be re-parented.`,
      [
        "Run 'dub log' to inspect the stack and find a non-root branch.",
        `Run 'dub untrack ${branch}' first if you need to detach the root.`,
      ],
    );
  }
  if (branchEntry.parent === parent) {
    return { branch, parent, status: 'unchanged', dryRun };
  }

  const descendants = new Set(getDescendants(sourceStack, branch));
  if (descendants.has(parent)) {
    throw new DubError(
      `Cannot track '${branch}' onto '${parent}' because it would create a cycle.`,
      [
        'Pick a parent branch that is not a descendant of the target.',
        "Run 'dub log' to inspect the stack layout.",
      ],
    );
  }

  if (sourceStack.id === destinationStack?.id) {
    branchEntry.parent = parent;
    assertStateInvariants(state.stacks);
    if (!dryRun) await writeState(state, cwd);
    return { branch, parent, status: 'reparented', dryRun };
  }

  const movingNames = new Set([branch, ...descendants]);
  const movingBranches = sourceStack.branches.filter((entry) =>
    movingNames.has(entry.name),
  );
  sourceStack.branches = sourceStack.branches.filter(
    (entry) => !movingNames.has(entry.name),
  );

  const movingRoot = movingBranches.find((entry) => entry.name === branch);
  if (!movingRoot) {
    throw new DubError(`Failed to move subtree for '${branch}'.`, [
      "Run 'dub doctor' to inspect the stack for metadata damage.",
    ]);
  }
  movingRoot.parent = parent;
  movingRoot.type = undefined;

  if (destinationStack) {
    destinationStack.branches.push(...movingBranches);
    destinationStack.trunk = getStackTrunk(destinationStack);
    ensureConfiguredTrunk(state, destinationStack.trunk);
  } else {
    state.stacks.push({
      id: crypto.randomUUID(),
      trunk: parent,
      branches: [
        {
          name: parent,
          type: 'root',
          parent: null,
          pr_number: null,
          pr_link: null,
          last_submitted_version: null,
          last_synced_at: null,
          sync_source: null,
        },
        ...movingBranches,
      ],
    });
    ensureConfiguredTrunk(state, parent);
  }

  state.stacks = state.stacks.filter((stack) => stack.branches.length > 0);
  assertStateInvariants(state.stacks);
  if (!dryRun) await writeState(state, cwd);
  return { branch, parent, status: 'reparented', dryRun };
}
