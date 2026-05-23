import { DubError } from './errors';
import { assertAcyclic } from './graph';
import type { Stack } from './state';

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
      if (branch.type === 'root') {
        if (branch.parent !== null) {
          throw new DubError(
            `Invalid stack '${stack.id}': root '${branch.name}' must have no parent.`,
            [
              "Run 'dub doctor' to inspect the stack.",
              `Run 'dub untrack ${branch.name}' to clear the bad metadata, then 'dub track ${branch.name}' to re-add it as a root.`,
              "Restore '.git/dubstack/state.json' from version control or backup if the metadata is corrupted.",
            ],
          );
        }
        continue;
      }
      if (!branch.parent || !branchMap.has(branch.parent)) {
        throw new DubError(
          `Invalid stack '${stack.id}': branch '${branch.name}' has missing parent '${branch.parent ?? 'null'}'.`,
          [
            "Run 'dub doctor' to identify the missing parent.",
            `Run 'dub track ${branch.name} --parent <branch>' to re-parent the affected branch onto a known parent.`,
          ],
        );
      }
    }
  }
}
