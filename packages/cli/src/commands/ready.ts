import type { ScopeMode } from '../lib/scope';
import { doctor } from './doctor';
import { getSubmitPlan, type SubmitPathMode } from './submit';

export interface ReadyResult {
  ready: boolean;
  scope: ScopeMode;
  checkedBranch: string;
  submitBranches: string[];
  submitPath: SubmitPathMode | null;
  rootBranch: string | null;
  blockers: string[];
}

export async function ready(
  cwd: string,
  options: { scope?: ScopeMode } = {},
): Promise<ReadyResult> {
  const scope = options.scope ?? 'downstack';
  const doctorResult = await doctor(cwd);
  const blockers: string[] = doctorResult.issues.map((issue) => issue.code);

  let submitBranches: string[] = [];
  let submitPath: SubmitPathMode | null = null;
  let rootBranch: string | null = null;

  try {
    const planPath: SubmitPathMode = scope === 'stack' ? 'stack' : 'current';
    const plan = await getSubmitPlan(cwd, { path: planPath });
    submitPath = plan.path;
    rootBranch = plan.rootBranch;

    const planBranches = plan.branches.map((b) => b.name);
    submitBranches =
      scope === 'current'
        ? planBranches.filter((name) => name === plan.currentBranch)
        : planBranches;

    if (submitBranches.length === 0) {
      blockers.push('submit-preflight');
    }
  } catch {
    blockers.push('submit-preflight');
  }

  return {
    ready: blockers.length === 0,
    scope,
    checkedBranch: doctorResult.checkedBranch,
    submitBranches,
    submitPath,
    rootBranch,
    blockers: Array.from(new Set(blockers)),
  };
}
