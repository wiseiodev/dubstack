import * as crypto from "node:crypto";
import { DubError } from "./errors";
import { branchExists } from "./git";
import { assertAcyclic, getDescendants } from "./graph";
import {
	addBranchToStack,
	ensureState,
	findStackForBranch,
	type Stack,
	writeState,
} from "./state";

export interface TrackBranchOptions {
	branch: string;
	parent: string;
}

export interface TrackBranchResult {
	branch: string;
	parent: string;
	status: "tracked" | "reparented" | "unchanged";
}

export async function validateTrackParent(
	cwd: string,
	branch: string,
	parent: string,
): Promise<void> {
	if (branch === parent) {
		throw new DubError("Branch cannot be its own parent.");
	}
	if (!(await branchExists(parent, cwd))) {
		throw new DubError(`Parent branch '${parent}' does not exist locally.`);
	}
}

/**
 * Tracks an existing local branch or updates its parent relationship.
 */
export async function trackBranch(
	cwd: string,
	options: TrackBranchOptions,
): Promise<TrackBranchResult> {
	const { branch, parent } = options;
	if (!(await branchExists(branch, cwd))) {
		throw new DubError(`Branch '${branch}' does not exist locally.`);
	}
	await validateTrackParent(cwd, branch, parent);

	const state = await ensureState(cwd);
	const sourceStack = findStackForBranch(state, branch);
	const destinationStack = findStackForBranch(state, parent);

	if (!sourceStack) {
		addBranchToStack(state, branch, parent);
		assertStateInvariants(state.stacks);
		await writeState(state, cwd);
		return { branch, parent, status: "tracked" };
	}

	const branchEntry = sourceStack.branches.find((entry) => entry.name === branch);
	if (!branchEntry) {
		throw new DubError(`Branch '${branch}' is missing from tracked state.`);
	}
	if (branchEntry.type === "root") {
		throw new DubError(
			`Branch '${branch}' is a stack root and cannot be re-parented.`,
		);
	}
	if (branchEntry.parent === parent) {
		return { branch, parent, status: "unchanged" };
	}

	const descendants = new Set(getDescendants(sourceStack, branch));
	if (descendants.has(parent)) {
		throw new DubError(
			`Cannot track '${branch}' onto '${parent}' because it would create a cycle.`,
		);
	}

	if (sourceStack.id === destinationStack?.id) {
		branchEntry.parent = parent;
		assertStateInvariants(state.stacks);
		await writeState(state, cwd);
		return { branch, parent, status: "reparented" };
	}

	const movingNames = new Set([branch, ...descendants]);
	const movingBranches = sourceStack.branches.filter((entry) =>
		movingNames.has(entry.name),
	);
	sourceStack.branches = sourceStack.branches.filter(
		(entry) => !movingNames.has(entry.name),
	);

	const movingRoot = movingBranches.find((entry) => entry.name === branch);
	if (!movingRoot) {
		throw new DubError(`Failed to move subtree for '${branch}'.`);
	}
	movingRoot.parent = parent;
	movingRoot.type = undefined;

	if (destinationStack) {
		destinationStack.branches.push(...movingBranches);
	} else {
		state.stacks.push({
			id: crypto.randomUUID(),
			branches: [
				{
					name: parent,
					type: "root",
					parent: null,
					pr_number: null,
					pr_link: null,
					last_submitted_version: null,
					last_synced_at: null,
					sync_source: null,
				},
				...movingBranches,
			],
		});
	}

	state.stacks = state.stacks.filter((stack) => stack.branches.length > 0);
	assertStateInvariants(state.stacks);
	await writeState(state, cwd);
	return { branch, parent, status: "reparented" };
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
