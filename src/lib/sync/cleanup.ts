import type { BranchPrLifecycleState } from "../github";

export interface CleanupPlan {
	toDelete: string[];
	skipped: Array<{ branch: string; reason: string }>;
}

export async function buildCleanupPlan(input: {
	branches: string[];
	getPrStatus: (branch: string) => Promise<BranchPrLifecycleState>;
	isMergedIntoAnyRoot: (branch: string) => Promise<boolean>;
}): Promise<CleanupPlan> {
	const toDelete: string[] = [];
	const skipped: Array<{ branch: string; reason: string }> = [];

	for (const branch of input.branches) {
		const prState = await input.getPrStatus(branch);
		if (prState !== "MERGED" && prState !== "CLOSED") {
			continue;
		}

		const mergedIntoRoot = await input.isMergedIntoAnyRoot(branch);
		if (!mergedIntoRoot) {
			skipped.push({ branch, reason: "commits-not-in-trunk" });
			continue;
		}

		toDelete.push(branch);
	}

	return { toDelete, skipped };
}
