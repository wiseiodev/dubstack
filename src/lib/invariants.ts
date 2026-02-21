import { DubError } from "./errors";
import { assertAcyclic } from "./graph";
import type { Stack } from "./state";

/**
 * Ensures stack metadata invariants hold after state mutations.
 */
export function assertStateInvariants(stacks: Stack[]) {
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
