import { getCurrentBranch } from '../lib/git';
import {
  type BranchPrLifecycleState,
  getBranchPrSyncInfo,
} from '../lib/github';
import {
  type ActiveOperation,
  detectActiveOperation,
} from '../lib/operation-state';
import { branchInfo } from './branch';
import { type DoctorIssue, doctor } from './doctor';

export interface BranchSnapshot {
  tracked: boolean;
  stackId: string | null;
  root: string | null;
  parent: string | null;
  children: string[];
}

export interface PrSnapshot {
  state: BranchPrLifecycleState | 'UNKNOWN';
  baseRefName: string | null;
  error?: string;
}

export interface DriftSnapshot {
  healthy: boolean;
  issues: DoctorIssue[];
}

export interface StatusResult {
  schemaVersion: 1;
  // `getCurrentBranch` throws DubError on detached HEAD, so callers always
  // receive a resolved branch name here. The CLI in DUB-28 may add a wrapper
  // that catches and surfaces a null/error snapshot to its consumers.
  currentBranch: string;
  operation: ActiveOperation;
  branch: BranchSnapshot;
  pr: PrSnapshot;
  drift: DriftSnapshot;
}

// `live` and `pr` are reserved for the upcoming `dub status` CLI (DUB-28);
// they currently have no effect on the snapshot returned to MCP callers.
export interface StatusOptions {
  live?: boolean;
  pr?: boolean;
}

/**
 * Returns a structured snapshot of the current branch's stack tracking, active
 * operation, PR lifecycle, and drift health. Shared by the `dubstack.status`
 * MCP tool and (in the future) the `dub status` CLI command.
 */
export async function status(
  cwd: string,
  _options?: StatusOptions,
): Promise<StatusResult> {
  const currentBranch = await getCurrentBranch(cwd);
  const info = await branchInfo(cwd, currentBranch);
  const operation = await detectActiveOperation(cwd);
  const pr: PrSnapshot = await getBranchPrSyncInfo(currentBranch, cwd).catch(
    (error): PrSnapshot => ({
      state: 'UNKNOWN',
      baseRefName: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const health = await doctor(cwd, { all: false, fetch: false });
  const drift = health.issues.filter(isDriftIssue);

  return {
    schemaVersion: 1,
    currentBranch,
    operation,
    branch: {
      tracked: info.tracked,
      stackId: info.stackId,
      root: info.root,
      parent: info.parent,
      children: info.children,
    },
    pr,
    drift: {
      healthy: drift.length === 0,
      issues: drift,
    },
  };
}

export function isDriftIssue(issue: DoctorIssue): boolean {
  return (
    issue.code === 'parent-mismatch' ||
    issue.code === 'remote-base-mismatch' ||
    issue.code === 'missing-local' ||
    issue.code === 'missing-remote' ||
    issue.code === 'remote-drift' ||
    issue.code === 'remote-check-failed'
  );
}
