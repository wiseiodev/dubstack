import { DubError } from '../lib/errors';
import {
  branchExists,
  fetchBranches,
  getCurrentBranch,
  getRefSha,
  remoteBranchExists,
} from '../lib/git';
import { detectActiveOperation } from '../lib/operation-state';
import {
  type Branch,
  findStackForBranch,
  readState,
  type Stack,
  topologicalOrder,
} from '../lib/state';

export type DoctorIssueCode =
  | 'operation-in-progress'
  | 'untracked-current-branch'
  | 'submit-branching-blocker'
  | 'missing-local'
  | 'missing-remote'
  | 'remote-drift'
  | 'remote-check-failed';

export interface DoctorIssue {
  code: DoctorIssueCode;
  summary: string;
  details: string;
  fixes: string[];
}

export interface DoctorResult {
  healthy: boolean;
  checkedBranch: string;
  issues: DoctorIssue[];
}

export async function doctor(
  cwd: string,
  options: { all?: boolean; fetch?: boolean } = {},
): Promise<DoctorResult> {
  const result: DoctorResult = {
    healthy: true,
    checkedBranch: await getCurrentBranch(cwd),
    issues: [],
  };
  const state = await readState(cwd);
  const scopedStacks = resolveScopedStacks(state.stacks, result.checkedBranch, {
    all: options.all ?? false,
  });

  const activeOperation = await detectActiveOperation(cwd);
  if (activeOperation !== 'none') {
    result.issues.push({
      code: 'operation-in-progress',
      summary: `A ${activeOperation} operation is in progress.`,
      details:
        activeOperation === 'restack'
          ? 'DubStack detected an interrupted restack flow.'
          : 'Git reports an active rebase operation.',
      fixes: ['dub continue', 'dub abort'],
    });
  }

  const allBranches = scopedStacks.flatMap((stack) => stack.branches);
  if (allBranches.length === 0) {
    result.issues.push({
      code: 'untracked-current-branch',
      summary: `Branch '${result.checkedBranch}' is not tracked in DubStack.`,
      details:
        'Doctor cannot evaluate stack health until the branch is tracked.',
      fixes: ['dub create <branch>', 'dub track --parent <branch>'],
    });
    result.healthy = false;
    return result;
  }

  const orderedPerStack = scopedStacks.map((stack) => topologicalOrder(stack));
  for (const ordered of orderedPerStack) {
    const blockers = findBranchingBlockers(ordered);
    for (const blocker of blockers) {
      result.issues.push({
        code: 'submit-branching-blocker',
        summary: `Submit is blocked by branching children under '${blocker.parent}'.`,
        details: `${blocker.parent} -> ${blocker.children.join(', ')}`,
        fixes: [
          'dub submit --path current',
          'dub submit --path stack --fix',
          'dub track <child> --parent <branch>',
        ],
      });
    }
  }

  const trackedNames = Array.from(
    new Set(allBranches.map((branch) => branch.name)),
  );
  if (options.fetch ?? true) {
    try {
      await fetchBranches(trackedNames, cwd);
    } catch {
      result.issues.push({
        code: 'remote-check-failed',
        summary: 'Could not refresh remote refs for doctor checks.',
        details:
          'Remote connectivity/auth failed while fetching branch refs. Drift checks may be incomplete.',
        fixes: ['git fetch --all --prune', 'dub sync --no-restack'],
      });
    }
  }

  for (const branch of allBranches) {
    if (branch.type === 'root') continue;
    await appendBranchHealthIssues(branch, cwd, result.issues);
  }

  result.healthy = result.issues.length === 0;
  return result;
}

function resolveScopedStacks(
  stacks: Stack[],
  currentBranch: string,
  options: { all: boolean },
): Stack[] {
  if (options.all) return stacks;
  const stack = findStackForBranch({ stacks }, currentBranch);
  if (!stack) return [];
  return [stack];
}

function findBranchingBlockers(
  ordered: Branch[],
): Array<{ parent: string; children: string[] }> {
  const branchSet = new Set(ordered.map((branch) => branch.name));
  const childMap = new Map<string, string[]>();

  for (const branch of ordered) {
    if (!branch.parent || !branchSet.has(branch.parent)) continue;
    const children = childMap.get(branch.parent) ?? [];
    children.push(branch.name);
    childMap.set(branch.parent, children);
  }

  return Array.from(childMap.entries())
    .filter(([, children]) => children.length > 1)
    .map(([parent, children]) => ({
      parent,
      children: [...children].sort(),
    }))
    .sort((a, b) => a.parent.localeCompare(b.parent));
}

async function appendBranchHealthIssues(
  branch: Branch,
  cwd: string,
  issues: DoctorIssue[],
): Promise<void> {
  const hasLocal = await branchExists(branch.name, cwd);
  const hasRemote = await remoteBranchExists(branch.name, cwd);

  if (!hasLocal) {
    issues.push({
      code: 'missing-local',
      summary: `Tracked branch '${branch.name}' is missing locally.`,
      details:
        'DubStack tracks this branch, but it does not exist in your local refs.',
      fixes: ['dub sync --no-restack', `dub untrack ${branch.name}`],
    });
  }

  if (!hasRemote) {
    issues.push({
      code: 'missing-remote',
      summary: `Tracked branch '${branch.name}' is missing on remote.`,
      details:
        'Remote branch does not exist. Submit/sync flows may skip or block this branch.',
      fixes: [`git push -u origin ${branch.name}`, 'dub prune --apply'],
    });
  }

  if (!hasLocal || !hasRemote) return;

  try {
    const localSha = await getRefSha(branch.name, cwd);
    const remoteSha = await getRefSha(`origin/${branch.name}`, cwd);
    if (localSha !== remoteSha) {
      issues.push({
        code: 'remote-drift',
        summary: `Branch '${branch.name}' differs from origin/${branch.name}.`,
        details:
          'Local and remote SHAs diverge. Reconcile before submit for predictable PR updates.',
        fixes: ['dub sync --no-restack', 'dub sync --force --no-restack'],
      });
    }
  } catch (error) {
    if (error instanceof DubError) {
      issues.push({
        code: 'remote-check-failed',
        summary: `Could not compare local/remote SHAs for '${branch.name}'.`,
        details: error.message,
        fixes: ['git fetch --all --prune', 'dub sync --no-restack'],
      });
    }
  }
}
