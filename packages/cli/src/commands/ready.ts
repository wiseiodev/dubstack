import type { ScopeMode } from '../lib/scope';
import { doctor } from './doctor';
import { getSubmitPlan, type SubmitOptions, type SubmitScope } from './submit';

export interface ReadyResult {
  ready: boolean;
  scope: ScopeMode;
  checkedBranch: string;
  submitBranches: string[];
  submitScope: SubmitScope | null;
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
  let submitScope: SubmitScope | null = null;
  let rootBranch: string | null = null;

  try {
    // 'current' uses downstack and narrows to the current branch below;
    // 'downstack' and 'stack' map directly to submit's same-named scopes.
    const planOptions: SubmitOptions =
      scope === 'stack' ? { stack: true } : { downstack: true };
    const plan = await getSubmitPlan(cwd, planOptions);
    submitScope = plan.scope;
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
    submitScope,
    rootBranch,
    blockers: Array.from(new Set(blockers)),
  };
}
