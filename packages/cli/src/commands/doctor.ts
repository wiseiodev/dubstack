import { DubError } from '../lib/errors';
import {
  branchExists,
  fetchBranches,
  getCurrentBranch,
  getRefSha,
  isAncestor,
  remoteBranchExists,
} from '../lib/git';
import { getBranchPrSyncInfo } from '../lib/github';
import { detectActiveOperation } from '../lib/operation-state';
import {
  type Branch,
  findStackForBranch,
  getConfiguredTrunks,
  getStackTrunk,
  readState,
  type Stack,
} from '../lib/state';

export type DoctorIssueCode =
  | 'operation-in-progress'
  | 'untracked-current-branch'
  | 'parent-mismatch'
  | 'remote-base-mismatch'
  | 'orphaned-stack'
  | 'missing-local'
  | 'missing-remote'
  | 'remote-drift'
  | 'remote-check-failed';

export type DoctorNoticeCode = 'frozen-branches';

export interface DoctorIssue {
  code: DoctorIssueCode;
  summary: string;
  details: string;
  fixes: string[];
}

export interface DoctorNotice {
  code: DoctorNoticeCode;
  summary: string;
  details: string;
  branches: string[];
}

export interface DoctorResult {
  healthy: boolean;
  checkedBranch: string;
  issues: DoctorIssue[];
  notices: DoctorNotice[];
}

export async function doctor(
  cwd: string,
  options: { all?: boolean; fetch?: boolean; skipGithub?: boolean } = {},
): Promise<DoctorResult> {
  const result: DoctorResult = {
    healthy: true,
    checkedBranch: await getCurrentBranch(cwd),
    issues: [],
    notices: [],
  };
  const state = await readState(cwd);
  const scopedStacks = resolveScopedStacks(state.stacks, result.checkedBranch, {
    all: options.all ?? false,
  });
  const configuredTrunks = new Set(getConfiguredTrunks(state));

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

  for (const stack of scopedStacks) {
    const trunk = getStackTrunk(stack);
    if (configuredTrunks.has(trunk)) continue;
    result.issues.push({
      code: 'orphaned-stack',
      summary: `Stack '${stack.id}' is rooted at unconfigured trunk '${trunk}'.`,
      details:
        'DubStack tracks this stack against a trunk that is no longer registered in state.',
      fixes: [`dub trunk add ${trunk}`, 'dub trunk list', 'dub log --all'],
    });
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
    await appendBranchHealthIssues(branch, cwd, result.issues, {
      skipGithub: options.skipGithub ?? false,
    });
  }

  const frozenBranches = allBranches
    .filter((branch) => branch.type !== 'root' && branch.frozen === true)
    .map((branch) => branch.name);
  if (frozenBranches.length > 0) {
    result.notices.push({
      code: 'frozen-branches',
      summary: `${frozenBranches.length} branch(es) are marked frozen.`,
      details:
        "Frozen branches are intentionally pinned and surfaced here so a stale flag doesn't go unnoticed. Run 'dub unfreeze <branch>' to clear the flag.",
      branches: frozenBranches,
    });
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

async function appendBranchHealthIssues(
  branch: Branch,
  cwd: string,
  issues: DoctorIssue[],
  options: { skipGithub: boolean },
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

    if (branch.parent) {
      const parentSha = await getRefSha(branch.parent, cwd);
      const basedOnParent = await isAncestor(parentSha, localSha, cwd);
      if (!basedOnParent) {
        issues.push({
          code: 'parent-mismatch',
          summary: `Branch '${branch.name}' is no longer based on '${branch.parent}'.`,
          details:
            'The tracked child branch is not descended from the current tip of its tracked parent, so structural stack drift is present and local submit/readiness checks would be misleading.',
          fixes: ['dub restack', 'dub doctor', 'dub submit'],
        });
      }
    }

    let githubBaseRef: string | null = null;
    if (!options.skipGithub) {
      try {
        const prInfo = await getBranchPrSyncInfo(branch.name, cwd);
        githubBaseRef = prInfo.state === 'OPEN' ? prInfo.baseRefName : null;
      } catch (error) {
        pushGithubCheckFailure(
          issues,
          branch.name,
          error,
          `Could not query GitHub PR info for '${branch.name}'.`,
        );
        githubBaseRef = null;
      }
    }

    if (githubBaseRef) {
      await fetchBranches([githubBaseRef], cwd);
    }

    if (githubBaseRef && (await remoteBranchExists(githubBaseRef, cwd))) {
      const remoteBaseSha = await getRefSha(`origin/${githubBaseRef}`, cwd);
      const basedOnRemoteBase = await isAncestor(remoteBaseSha, remoteSha, cwd);
      if (!basedOnRemoteBase) {
        issues.push({
          code: 'remote-base-mismatch',
          summary: `Branch '${branch.name}' is not based on GitHub base '${githubBaseRef}'.`,
          details: `GitHub is evaluating this PR against origin/${githubBaseRef}, but the remote branch tip is not descended from that base. GitHub may still report merge conflicts even when local parent checks pass.`,
          fixes: [
            `git checkout ${githubBaseRef} && git pull --ff-only origin ${githubBaseRef}`,
            'dub restack',
            'dub submit',
            'dub merge-check',
          ],
        });
      }
    }
  } catch (error) {
    if (error instanceof DubError) {
      pushRemoteCheckFailed(
        issues,
        `Could not compare local/remote SHAs for '${branch.name}'.`,
        error.message,
      );
    }
  }
}

function pushGithubCheckFailure(
  issues: DoctorIssue[],
  branchName: string,
  error: unknown,
  summary: string,
): void {
  const details =
    error instanceof Error && error.message
      ? error.message
      : `The GitHub PR base-drift check could not be performed for '${branchName}'. Ensure the GitHub CLI ('gh') is installed, authenticated, and that the repository has network access.`;
  pushRemoteCheckFailed(issues, summary, details);
}

function pushRemoteCheckFailed(
  issues: DoctorIssue[],
  summary: string,
  details: string,
): void {
  issues.push({
    code: 'remote-check-failed',
    summary,
    details,
    fixes: ['gh auth status', 'gh auth login', 'git fetch --all --prune'],
  });
}
