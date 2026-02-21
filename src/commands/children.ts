import { DubError } from "../lib/errors";
import { getCurrentBranch } from "../lib/git";
import { findStackForBranch, readState } from "../lib/state";

interface ChildrenResult {
	branch: string;
	children: string[];
}

export async function children(
	cwd: string,
	branchArg?: string,
): Promise<ChildrenResult> {
	const branch = branchArg ?? (await getCurrentBranch(cwd));
	const state = await readState(cwd);
	const stack = findStackForBranch(state, branch);
	if (!stack) {
		throw new DubError(
			`Branch '${branch}' is not tracked. Run 'dub track ${branch} --parent <branch>' first.`,
		);
	}
	const childBranches = stack.branches
		.filter((entry) => entry.parent === branch)
		.map((entry) => entry.name)
		.sort();
	return { branch, children: childBranches };
}
