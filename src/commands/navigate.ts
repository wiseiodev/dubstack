import { DubError } from "../lib/errors";
import { checkoutBranch, getCurrentBranch } from "../lib/git";
import { findStackForBranch, readState, type Stack } from "../lib/state";

interface NavigateResult {
	branch: string;
	changed: boolean;
}

function getBranchByName(stack: Stack, name: string) {
	return stack.branches.find((branch) => branch.name === name);
}

function getChildren(stack: Stack, parent: string): string[] {
	return stack.branches
		.filter((branch) => branch.parent === parent)
		.map((branch) => branch.name);
}

function getTrackedStackOrThrow(
	stateBranch: string,
	stack: Stack | undefined,
): Stack {
	if (!stack) {
		throw new DubError(
			`Current branch '${stateBranch}' is not tracked by DubStack.`,
		);
	}
	return stack;
}

/**
 * Checkout the direct child branch of the current branch.
 * Requires a linear stack path.
 */
export async function up(cwd: string): Promise<NavigateResult> {
	const state = await readState(cwd);
	const current = await getCurrentBranch(cwd);
	const stack = getTrackedStackOrThrow(
		current,
		findStackForBranch(state, current),
	);

	const children = getChildren(stack, current);
	if (children.length === 0) {
		throw new DubError(`No branch above '${current}' in the current stack.`);
	}
	if (children.length > 1) {
		throw new DubError(
			`Branch '${current}' has multiple children; 'dub up' requires a linear stack path.`,
		);
	}

	await checkoutBranch(children[0], cwd);
	return { branch: children[0], changed: children[0] !== current };
}

/**
 * Checkout the direct parent branch of the current branch.
 */
export async function down(cwd: string): Promise<NavigateResult> {
	const state = await readState(cwd);
	const current = await getCurrentBranch(cwd);
	const stack = getTrackedStackOrThrow(
		current,
		findStackForBranch(state, current),
	);
	const branch = getBranchByName(stack, current);

	if (!branch) {
		throw new DubError(
			`Current branch '${current}' is not tracked by DubStack.`,
		);
	}
	if (!branch.parent) {
		throw new DubError(
			`Already at the bottom of the stack (root branch '${current}').`,
		);
	}

	await checkoutBranch(branch.parent, cwd);
	return { branch: branch.parent, changed: branch.parent !== current };
}

/**
 * Checkout the topmost descendant reachable by following a single-child path.
 */
export async function top(cwd: string): Promise<NavigateResult> {
	const state = await readState(cwd);
	const current = await getCurrentBranch(cwd);
	const stack = getTrackedStackOrThrow(
		current,
		findStackForBranch(state, current),
	);

	let target = current;
	while (true) {
		const children = getChildren(stack, target);
		if (children.length === 0) break;
		if (children.length > 1) {
			throw new DubError(
				`Branch '${target}' has multiple children; 'dub top' requires a linear stack path.`,
			);
		}
		target = children[0];
	}

	if (target !== current) {
		await checkoutBranch(target, cwd);
	}
	return { branch: target, changed: target !== current };
}

/**
 * Checkout the first branch above the root for the current stack path.
 */
export async function bottom(cwd: string): Promise<NavigateResult> {
	const state = await readState(cwd);
	const current = await getCurrentBranch(cwd);
	const stack = getTrackedStackOrThrow(
		current,
		findStackForBranch(state, current),
	);
	const branch = getBranchByName(stack, current);

	if (!branch) {
		throw new DubError(
			`Current branch '${current}' is not tracked by DubStack.`,
		);
	}

	let target = current;
	if (!branch.parent) {
		const children = getChildren(stack, current);
		if (children.length === 0) {
			throw new DubError(
				`No branch above root '${current}' in the current stack.`,
			);
		}
		if (children.length > 1) {
			throw new DubError(
				`Root branch '${current}' has multiple children; 'dub bottom' requires a linear stack path.`,
			);
		}
		target = children[0];
	} else {
		let node = branch;
		while (node.parent) {
			const parent = getBranchByName(stack, node.parent);
			if (!parent) {
				break;
			}
			if (parent.parent === null) {
				target = node.name;
				break;
			}
			node = parent;
		}
	}

	if (target !== current) {
		await checkoutBranch(target, cwd);
	}
	return { branch: target, changed: target !== current };
}
