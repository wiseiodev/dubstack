import { DubError } from "./errors";
import type { Branch, Stack } from "./state";

function buildChildMap(stack: Stack): Map<string, Branch[]> {
	const childMap = new Map<string, Branch[]>();
	for (const branch of stack.branches) {
		if (!branch.parent) continue;
		const children = childMap.get(branch.parent) ?? [];
		children.push(branch);
		childMap.set(branch.parent, children);
	}
	return childMap;
}

function buildBranchMap(stack: Stack): Map<string, Branch> {
	return new Map(stack.branches.map((branch) => [branch.name, branch]));
}

/**
 * Returns descendants of a branch in breadth-first order.
 */
export function getDescendants(stack: Stack, branchName: string): string[] {
	const childMap = buildChildMap(stack);
	const descendants: string[] = [];
	const queue = [...(childMap.get(branchName) ?? [])];

	while (queue.length > 0) {
		const next = queue.shift();
		if (!next) break;
		descendants.push(next.name);
		queue.push(...(childMap.get(next.name) ?? []));
	}

	return descendants;
}

/**
 * Returns ancestors of a branch, starting at the immediate parent.
 */
export function getAncestors(stack: Stack, branchName: string): string[] {
	const branchMap = buildBranchMap(stack);
	const ancestors: string[] = [];
	const seen = new Set<string>();

	let current = branchMap.get(branchName);
	while (current?.parent) {
		if (seen.has(current.parent)) break;
		ancestors.push(current.parent);
		seen.add(current.parent);
		current = branchMap.get(current.parent);
	}

	return ancestors;
}

/**
 * Throws if a stack contains a cycle in parent pointers.
 */
export function assertAcyclic(stack: Stack): void {
	const branchMap = buildBranchMap(stack);
	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(name: string) {
		if (visited.has(name)) return;
		if (visiting.has(name)) {
			throw new DubError(
				`Invalid stack '${stack.id}': cycle detected at '${name}'.`,
			);
		}

		visiting.add(name);
		const branch = branchMap.get(name);
		if (branch?.parent && branchMap.has(branch.parent)) {
			visit(branch.parent);
		}
		visiting.delete(name);
		visited.add(name);
	}

	for (const branch of stack.branches) {
		visit(branch.name);
	}
}
