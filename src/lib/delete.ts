import { DubError } from "./errors";
import { checkoutBranch, deleteLocalBranch, getCurrentBranch } from "./git";
import { assertAcyclic, getAncestors, getDescendants } from "./graph";
import { findStackForBranch, readState, type Stack, writeState } from "./state";

export interface DeleteTrackedOptions {
	branch: string;
	upstack?: boolean;
	downstack?: boolean;
	force?: boolean;
}

export interface DeleteTrackedResult {
	deleted: string[];
	reparented: Array<{ branch: string; parent: string | null }>;
}

export interface DeletePreview {
	branch: string;
	targets: string[];
}

export async function getDeletePreview(
	cwd: string,
	options: Pick<DeleteTrackedOptions, "branch" | "upstack" | "downstack">,
): Promise<DeletePreview> {
	const state = await readState(cwd);
	const stack = findStackForBranch(state, options.branch);
	if (!stack) {
		throw new DubError(
			`Branch '${options.branch}' is not tracked. Run 'dub track ${options.branch} --parent <branch>' first.`,
		);
	}
	const targets = collectTargets(stack, options);
	return { branch: options.branch, targets };
}

/**
 * Deletes tracked branches from git and removes them from DubStack metadata.
 */
export async function deleteTrackedBranch(
	cwd: string,
	options: DeleteTrackedOptions,
): Promise<DeleteTrackedResult> {
	const state = await readState(cwd);
	const stack = findStackForBranch(state, options.branch);
	if (!stack) {
		throw new DubError(
			`Branch '${options.branch}' is not tracked by DubStack.`,
		);
	}

	const targets = collectTargets(stack, options);
	const deleteSet = new Set(targets);

	const currentBranch = await getCurrentBranch(cwd);
	if (deleteSet.has(currentBranch)) {
		const fallback = resolveFallbackBranch(stack, options.branch, deleteSet);
		await checkoutBranch(fallback, cwd);
	}

	for (const branch of targets) {
		await deleteLocalBranch(branch, cwd, options.force ?? false);
	}

	const deletedParent = new Map<string, string | null>();
	for (const branch of stack.branches) {
		if (deleteSet.has(branch.name)) {
			deletedParent.set(branch.name, branch.parent);
		}
	}

	stack.branches = stack.branches.filter(
		(branch) => !deleteSet.has(branch.name),
	);

	const reparented: Array<{ branch: string; parent: string | null }> = [];
	for (const branch of stack.branches) {
		let parent = branch.parent;
		while (parent && deleteSet.has(parent)) {
			parent = deletedParent.get(parent) ?? null;
		}
		if (parent !== branch.parent) {
			branch.parent = parent;
			reparented.push({ branch: branch.name, parent: branch.parent });
		}
	}

	state.stacks = state.stacks.filter(
		(candidate) => candidate.branches.length > 0,
	);
	assertStateInvariants(state.stacks);
	await writeState(state, cwd);

	return {
		deleted: targets,
		reparented,
	};
}

function collectTargets(
	stack: Stack,
	options: Pick<DeleteTrackedOptions, "branch" | "upstack" | "downstack">,
): string[] {
	const target = stack.branches.find(
		(branch) => branch.name === options.branch,
	);
	if (!target) {
		throw new DubError(
			`Branch '${options.branch}' is missing from tracked stack.`,
		);
	}
	if (target.type === "root") {
		throw new DubError(
			`Cannot delete root branch '${options.branch}' via dub delete.`,
		);
	}

	const stackBranchMap = new Map(
		stack.branches.map((branch) => [branch.name, branch]),
	);
	const targets = new Set<string>([options.branch]);

	if (options.upstack) {
		for (const descendant of getDescendants(stack, options.branch)) {
			targets.add(descendant);
		}
	}
	if (options.downstack) {
		for (const ancestor of getAncestors(stack, options.branch)) {
			if (stackBranchMap.get(ancestor)?.type === "root") continue;
			targets.add(ancestor);
		}
	}

	return [...targets].sort(
		(a, b) => getAncestors(stack, b).length - getAncestors(stack, a).length,
	);
}

function resolveFallbackBranch(
	stack: Stack,
	targetBranch: string,
	deleteSet: Set<string>,
): string {
	const ancestors = getAncestors(stack, targetBranch);
	for (const ancestor of ancestors) {
		if (!deleteSet.has(ancestor)) return ancestor;
	}
	const root = stack.branches.find((branch) => branch.type === "root")?.name;
	if (root && !deleteSet.has(root)) return root;
	throw new DubError(
		"Unable to determine a safe checkout target before deleting current branch.",
	);
}

function assertStateInvariants(stacks: Stack[]) {
	for (const stack of stacks) {
		assertAcyclic(stack);
		const branchMap = new Map(
			stack.branches.map((branch) => [branch.name, branch]),
		);
		for (const branch of stack.branches) {
			if (branch.type === "root") {
				if (branch.parent !== null) {
					throw new DubError(
						`Invalid stack '${stack.id}': root '${branch.name}' must have no parent.`,
					);
				}
				continue;
			}
			if (!branch.parent || !branchMap.has(branch.parent)) {
				throw new DubError(
					`Invalid stack '${stack.id}': branch '${branch.name}' has missing parent '${branch.parent ?? "null"}'.`,
				);
			}
		}
	}
}
