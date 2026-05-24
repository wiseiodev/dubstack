import { DubError } from './errors';
import { type Branch, type Stack, topologicalOrder } from './state';

/**
 * Validation scope for commands that walk a stack.
 *
 * - `current`: just the current branch
 * - `downstack`: current branch plus ancestors toward trunk
 * - `stack`: every branch in the stack (siblings included)
 */
export type ScopeMode = 'current' | 'downstack' | 'stack';

export const SCOPE_MODES: ScopeMode[] = ['current', 'downstack', 'stack'];

export function parseScope(value: string): ScopeMode {
  if (value === 'current' || value === 'downstack' || value === 'stack') {
    return value;
  }
  throw new DubError(
    "Scope must be one of: 'current', 'downstack', or 'stack'.",
    [
      "Pass '--scope current' to check only the current branch.",
      "Pass '--scope downstack' to check the current branch and its ancestors.",
      "Pass '--scope stack' to check every branch in the stack.",
    ],
  );
}

/**
 * Returns the branches in `stack` selected by `scope`. Root branches are
 * always excluded. Order is deterministic: downstack walks root → leaf
 * along the ancestor chain; stack uses topological (BFS) order; current
 * returns a single-element list.
 *
 * For `current` and `downstack`, the result is anchored on `currentBranch`,
 * and an empty list is returned when `currentBranch` is a root or not
 * present in the stack. For `stack`, every non-root branch is returned
 * regardless of `currentBranch`.
 */
export function resolveScopeBranches(
  stack: Stack,
  currentBranch: string,
  scope: ScopeMode,
): Branch[] {
  if (scope === 'stack') {
    return topologicalOrder(stack).filter((b) => b.type !== 'root');
  }

  const branchMap = new Map(stack.branches.map((b) => [b.name, b]));
  const cursor = branchMap.get(currentBranch);
  if (!cursor || cursor.type === 'root') return [];

  if (scope === 'current') return [cursor];

  const path: Branch[] = [];
  const seen = new Set<string>();
  let current: Branch | undefined = cursor;
  while (current && current.type !== 'root') {
    if (seen.has(current.name)) {
      throw new DubError(
        `Stack metadata is invalid: cycle detected while tracing '${currentBranch}'.`,
        [
          "Run 'dub doctor' to inspect the stack and surface the bad parent link.",
          "Run 'dub track <branch> --parent <branch>' to re-parent the affected branch.",
        ],
      );
    }
    seen.add(current.name);
    path.push(current);
    current = current.parent ? branchMap.get(current.parent) : undefined;
  }
  return path.reverse();
}
