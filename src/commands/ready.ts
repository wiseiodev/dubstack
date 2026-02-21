import { doctor } from "./doctor";
import { getSubmitPlan } from "./submit";

export interface ReadyResult {
	ready: boolean;
	checkedBranch: string;
	submitBranches: string[];
	submitPath: "current" | "stack" | null;
	rootBranch: string | null;
	blockers: string[];
}

export async function ready(cwd: string): Promise<ReadyResult> {
	const doctorResult = await doctor(cwd);
	const blockers: string[] = doctorResult.issues.map((issue) => issue.code);

	let submitBranches: string[] = [];
	let submitPath: "current" | "stack" | null = null;
	let rootBranch: string | null = null;

	try {
		const plan = await getSubmitPlan(cwd, { path: "current" });
		submitBranches = plan.branches.map((branch) => branch.name);
		submitPath = plan.path;
		rootBranch = plan.rootBranch;
		if (submitBranches.length === 0) {
			blockers.push("submit-preflight");
		}
	} catch {
		blockers.push("submit-preflight");
	}

	return {
		ready: blockers.length === 0,
		checkedBranch: doctorResult.checkedBranch,
		submitBranches,
		submitPath,
		rootBranch,
		blockers: Array.from(new Set(blockers)),
	};
}
