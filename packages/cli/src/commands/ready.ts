import { doctor } from './doctor';
import { getSubmitPlan, type SubmitScope } from './submit';

export interface ReadyResult {
  ready: boolean;
  checkedBranch: string;
  submitBranches: string[];
  submitScope: SubmitScope | null;
  rootBranch: string | null;
  blockers: string[];
}

export async function ready(cwd: string): Promise<ReadyResult> {
  const doctorResult = await doctor(cwd);
  const blockers: string[] = doctorResult.issues.map((issue) => issue.code);

  let submitBranches: string[] = [];
  let submitScope: SubmitScope | null = null;
  let rootBranch: string | null = null;

  try {
    const plan = await getSubmitPlan(cwd, { downstack: true });
    submitBranches = plan.branches.map((branch) => branch.name);
    submitScope = plan.scope;
    rootBranch = plan.rootBranch;
    if (submitBranches.length === 0) {
      blockers.push('submit-preflight');
    }
  } catch {
    blockers.push('submit-preflight');
  }

  return {
    ready: blockers.length === 0,
    checkedBranch: doctorResult.checkedBranch,
    submitBranches,
    submitScope,
    rootBranch,
    blockers: Array.from(new Set(blockers)),
  };
}
