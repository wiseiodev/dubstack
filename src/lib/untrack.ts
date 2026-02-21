import { DubError } from "./errors";
import { assertAcyclic, getDescendants } from "./graph";
import { findStackForBranch, readState, type Stack, writeState } from "./state";

export interface UntrackOptions {
	branch: string;
	downstack?: boolean;
}

export interface UntrackResult {
	removed: string[];
	reparented: Array<{ branch: string; parent: string | null }>;
}

export interface UntrackContext {
	stack: Stack;
	branch: string;
	descendants: string[];
}

export async function getUntrackContext(
	cwd: string,
	branch: string,
): Promise<UntrackContext> {
	const state = await readState(cwd);
	const stack = findStackForBranch(state, branch);
	if (!stack) {
		throw new DubError(
			`Branch '${branch}' is not tracked. Run 'dub track ${branch} --parent <branch>' first.`,
		);
	}
	return {
		stack,
		branch,
		descendants: getDescendants(stack, branch),
	};
}

/**
 * Removes a branch from DubStack tracking metadata without deleting git branches.
 */
export async function untrackBranch(
	cwd: string,
	options: UntrackOptions,
): Promise<UntrackResult> {
	const state = await readState(cwd);
	const stack = findStackForBranch(state, options.branch);
	if (!stack) {
		throw new DubError(`Branch '${options.branch}' is not tracked by DubStack.`);
	}

	const entry = stack.branches.find((branch) => branch.name === options.branch);
	if (!entry) {
		throw new DubError(`Branch '${options.branch}' is missing from tracked stack.`);
	}

	const descendants = getDescendants(stack, options.branch);
	const removedSet = new Set<string>(
		options.downstack ? [options.branch, ...descendants] : [options.branch],
	);

	if (entry.type === "root" && !options.downstack && descendants.length > 0) {
		throw new DubError(
			`Branch '${options.branch}' is a root with descendants. Use --downstack to untrack the whole subtree.`,
		);
	}

	const reparented: Array<{ branch: string; parent: string | null }> = [];
	if (!options.downstack) {
		for (const branch of stack.branches) {
			if (branch.parent !== options.branch) continue;
			branch.parent = entry.parent;
			reparented.push({ branch: branch.name, parent: branch.parent });
		}
	}

	stack.branches = stack.branches.filter((branch) => !removedSet.has(branch.name));
	state.stacks = state.stacks.filter((candidate) => candidate.branches.length > 0);

	assertStateInvariants(state.stacks);
	await writeState(state, cwd);

	return {
		removed: [options.branch, ...(options.downstack ? descendants : [])],
		reparented,
	};
}

function assertStateInvariants(stacks: Stack[]) {
	for (const stack of stacks) {
		assertAcyclic(stack);
		const branchMap = new Map(stack.branches.map((branch) => [branch.name, branch]));
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
