import { DubError } from "../lib/errors";
import {
	branchExists,
	commitStaged,
	createBranch,
	getCurrentBranch,
	hasStagedChanges,
	interactiveStage,
	stageAll,
	stageUpdate,
} from "../lib/git";
import { addBranchToStack, ensureState, writeState } from "../lib/state";
import { saveUndoEntry } from "../lib/undo-log";

interface CreateOptions {
	message?: string;
	all?: boolean;
	update?: boolean;
	patch?: boolean;
}

interface CreateResult {
	branch: string;
	parent: string;
	committed?: string;
}

/**
 * Creates a new branch stacked on top of the current branch.
 *
 * When `-m` is provided, also commits staged changes on the new branch.
 * When `-a` is provided, stages all changes first (requires `-m`).
 *
 * @param name - Name of the new branch to create
 * @param cwd - Working directory (auto-initializes if needed)
 * @param options - Optional message and all flags
 * @returns The created branch name, its parent, and committed message if applicable
 * @throws {DubError} If branch exists, HEAD is detached, -a without -m, or nothing to commit
 */
export async function create(
	name: string,
	cwd: string,
	options?: CreateOptions,
): Promise<CreateResult> {
	if ((options?.all || options?.update || options?.patch) && !options.message) {
		throw new DubError(
			"'--all', '--update', and '--patch' require '-m'. Pass a commit message.",
		);
	}

	const state = await ensureState(cwd);
	const parent = await getCurrentBranch(cwd);

	if (await branchExists(name, cwd)) {
		throw new DubError(`Branch '${name}' already exists.`);
	}

	if (options?.message) {
		if (options.patch) {
			await interactiveStage(cwd);
		} else if (options.all) {
			await stageAll(cwd);
		} else if (options.update) {
			await stageUpdate(cwd);
		}

		if (!(await hasStagedChanges(cwd))) {
			const hint = options.all
				? "No changes to commit."
				: "No staged changes. Stage files with 'git add' or use '-a' to stage all.";
			throw new DubError(hint);
		}
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

	if (options?.message) {
		try {
			await commitStaged(options.message, cwd);
		} catch (error) {
			const reason = error instanceof DubError ? error.message : String(error);
			throw new DubError(
				`Branch '${name}' was created but commit failed: ${reason}. Run 'dub undo' to clean up.`,
			);
		}
		return { branch: name, parent, committed: options.message };
	}

	return { branch: name, parent };
}
