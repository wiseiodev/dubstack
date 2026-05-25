import { DubError } from '../lib/errors';
import { getCurrentBranch, isValidBranchName } from '../lib/git';
import {
  ensureConfiguredTrunk,
  findStackForBranch,
  getConfiguredTrunks,
  getDefaultTrunk,
  getStackTrunk,
  readState,
  writeState,
} from '../lib/state';

export interface TrunkResult {
  branch: string;
  trunk: string;
}

export interface TrunkListResult {
  trunks: Array<{ name: string; default: boolean }>;
}

export async function trunk(
  cwd: string,
  branchArg?: string,
): Promise<TrunkResult> {
  const branch = branchArg ?? (await getCurrentBranch(cwd));
  const state = await readState(cwd);
  const stack = findStackForBranch(state, branch);
  if (!stack) {
    throw new DubError(`Branch '${branch}' is not tracked.`, [
      `Run 'dub track ${branch} --parent <branch>' to track it.`,
      "Run 'dub log' to see currently tracked branches.",
    ]);
  }
  const root = stack.branches.find((candidate) => candidate.type === 'root');
  if (!stack.trunk && !root) {
    throw new DubError(`Stack for '${branch}' is missing a root branch.`, [
      "Run 'dub track <root>' to mark the trunk as the stack root.",
      "Run 'dub doctor' to inspect the stack for metadata damage.",
    ]);
  }
  return { branch, trunk: getStackTrunk(stack) };
}

export async function listTrunks(cwd: string): Promise<TrunkListResult> {
  const state = await readState(cwd);
  const defaultTrunk = getDefaultTrunk(state);
  return {
    trunks: getConfiguredTrunks(state).map((name) => ({
      name,
      default: name === defaultTrunk,
    })),
  };
}

export async function addTrunk(
  cwd: string,
  name: string,
): Promise<{ trunk: string; status: 'added' | 'already-exists' }> {
  const trunkName = normalizeTrunkName(name);
  if (!(await isValidBranchName(trunkName, cwd))) {
    throw new DubError(`Trunk name '${trunkName}' is invalid.`, [
      'Use a valid git branch name, such as main, develop, or release/2.0.',
    ]);
  }

  const state = await readState(cwd);
  const exists = getConfiguredTrunks(state).includes(trunkName);
  ensureConfiguredTrunk(state, trunkName);
  await writeState(state, cwd);
  return {
    trunk: trunkName,
    status: exists ? 'already-exists' : 'added',
  };
}

export async function removeTrunk(
  cwd: string,
  name: string,
): Promise<{ trunk: string }> {
  const trunkName = normalizeTrunkName(name);
  const state = await readState(cwd);
  if (!getConfiguredTrunks(state).includes(trunkName)) {
    throw new DubError(`Trunk '${trunkName}' is not configured.`, [
      "Run 'dub trunk list' to see configured trunks.",
    ]);
  }

  const rootedStacks = state.stacks.filter(
    (stack) => getStackTrunk(stack) === trunkName,
  );
  if (rootedStacks.length > 0) {
    throw new DubError(`Cannot remove trunk '${trunkName}'.`, [
      `${rootedStacks.length} stack(s) are still rooted at '${trunkName}'.`,
      "Run 'dub log --all' to inspect stacks before removing this trunk.",
    ]);
  }

  const nextTrunks = getConfiguredTrunks(state).filter(
    (trunk) => trunk !== trunkName,
  );
  if (nextTrunks.length === 0) {
    throw new DubError(
      `Cannot remove the last configured trunk '${trunkName}'.`,
      ["Run 'dub trunk add <name>' before removing the last trunk."],
    );
  }

  state.trunks = nextTrunks;
  if (state.defaultTrunk === trunkName) {
    state.defaultTrunk = nextTrunks[0];
  }
  await writeState(state, cwd);
  return { trunk: trunkName };
}

export async function setDefaultTrunk(
  cwd: string,
  name: string,
): Promise<{ trunk: string }> {
  const trunkName = normalizeTrunkName(name);
  const state = await readState(cwd);
  if (!getConfiguredTrunks(state).includes(trunkName)) {
    throw new DubError(`Trunk '${trunkName}' is not configured.`, [
      `Run 'dub trunk add ${trunkName}' before making it the default.`,
      "Run 'dub trunk list' to see configured trunks.",
    ]);
  }
  state.defaultTrunk = trunkName;
  await writeState(state, cwd);
  return { trunk: trunkName };
}

function normalizeTrunkName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new DubError('Trunk name is required.', [
      "Run 'dub trunk add <name>' with a branch name.",
    ]);
  }
  return normalized;
}
