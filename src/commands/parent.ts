import { DubError } from "../lib/errors";
import { getCurrentBranch } from "../lib/git";
import { findStackForBranch, readState } from "../lib/state";

interface ParentResult {
	branch: string;
	parent: string;
}

export async function parent(cwd: string, branchArg?: string): Promise<ParentResult> {
	const branch = branchArg ?? (await getCurrentBranch(cwd));
	const state = await readState(cwd);
	const stack = findStackForBranch(state, branch);
	if (!stack) {
		throw new DubError(
			`Branch '${branch}' is not tracked. Run 'dub track ${branch} --parent <branch>' first.`,
		);
	}
	const entry = stack.branches.find((candidate) => candidate.name === branch);
	if (!entry || !entry.parent) {
		throw new DubError(`Branch '${branch}' is at the root and has no parent.`);
	}
	return { branch, parent: entry.parent };
}
