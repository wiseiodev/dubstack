import { DubError } from "../lib/errors.js";
import { branchExists, createBranch, getCurrentBranch } from "../lib/git.js";
import { addBranchToStack, readState, writeState } from "../lib/state.js";
import { saveUndoEntry } from "../lib/undo-log.js";

interface CreateResult {
	branch: string;
	parent: string;
}

/**
 * Creates a new branch stacked on top of the current branch.
 *
 * Records the parent-child relationship in dubstack state so the stack
 * can be restacked later. Saves an undo entry before mutating.
 *
 * @param name - Name of the new branch to create
 * @param cwd - Working directory (must be inside an initialized dubstack repo)
 * @returns The created branch name and its parent
 * @throws {DubError} If not initialized, branch exists, HEAD is detached, or repo is empty
 */
export async function create(name: string, cwd: string): Promise<CreateResult> {
	const state = await readState(cwd);
	const parent = await getCurrentBranch(cwd);

	if (await branchExists(name, cwd)) {
		throw new DubError(`Branch '${name}' already exists.`);
	}

	await saveUndoEntry(
		{
			operation: "create",
			timestamp: new Date().toISOString(),
			previousBranch: parent,
			previousState: structuredClone(state),
			branchTips: {},
			createdBranches: [name],
		},
		cwd,
	);

	await createBranch(name, cwd);
	addBranchToStack(state, name, parent);
	await writeState(state, cwd);

	return { branch: name, parent };
}
