import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import {
  branchExists,
  getBranchTip,
  getCurrentBranch,
  isWorkingTreeClean,
} from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import { assertAcyclic, getDescendants } from '../lib/graph';
import { assertStateInvariants } from '../lib/invariants';
import {
  type Branch,
  findStackForBranch,
  readState,
  type Stack,
  writeState,
} from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
import { assertBranchesNotCheckedOutElsewhere } from '../lib/worktree-guards';
import { restack } from './restack';

export interface MoveOptions {
  before?: string;
  after?: string;
  dryRun?: boolean;
}

export type MovePosition = 'before' | 'after';

export interface MoveResult {
  branch: string;
  target: string;
  position: MovePosition;
  /** New parent of `<branch>` after the move. */
  newParent: string;
  /** Branches whose parent pointer changed. */
  reparented: string[];
  /** Branches rebased by the cascading restack. */
  rebased: string[];
  /** Branches whose PR base was retargeted. */
  retargeted: string[];
  /** True when nothing changed (target was already in the requested position). */
  noOp: boolean;
  /** Human-readable explanation set when `noOp` is true. */
  noOpReason?: string;
  /** Set when the cascading restack hit a conflict and needs `dub continue`. */
  conflictBranch?: string;
  /** True when invoked with `--dry-run`; no mutations were performed. */
  dryRun: boolean;
}

interface ReparentPlan {
  branch: string;
  oldParent: string | null;
  newParent: string;
}

/**
 * Reorganizes the stack by inserting `<branch>` between `<target>` and one of
 * its neighbors.
 *
 * - `--before <target>`: `<branch>` becomes `<target>`'s new parent. `<branch>`
 *   inherits `<target>`'s previous parent.
 * - `--after <target>`: `<branch>` becomes a child of `<target>` and absorbs
 *   `<target>`'s previous children (so a chain `target → child` becomes
 *   `target → branch → child`).
 *
 * Workflow:
 * 1. Validate both branches exist locally and are tracked in the same stack.
 * 2. Detect cycles and no-ops up front.
 * 3. Open a cleanup journal so a crash mid-flow is resumable by `dub continue`.
 * 4. Apply parent changes to in-memory state and persist `state.json`.
 * 5. Retarget any open PRs whose base no longer matches their new parent.
 * 6. Run `restack` to rebase descendants onto their new parents.
 * 7. Save a `move` undo entry so `dub undo` rolls back the entire operation.
 */
export async function move(
  cwd: string,
  branch: string,
  options: MoveOptions,
): Promise<MoveResult> {
  const hasBefore = typeof options.before === 'string' && options.before !== '';
  const hasAfter = typeof options.after === 'string' && options.after !== '';
  if (hasBefore === hasAfter) {
    throw new DubError("Specify exactly one of '--before' or '--after'.", [
      "Pass '--before <target>' to insert <branch> as the new parent of <target>.",
      "Pass '--after <target>' to insert <branch> as the new child of <target>.",
    ]);
  }

  const position: MovePosition = hasBefore ? 'before' : 'after';
  // `hasBefore`/`hasAfter` were validated above to be a non-empty string for
  // exactly one of the two options, so target is always defined.
  const target = (hasBefore ? options.before : options.after) ?? '';

  if (branch === target) {
    throw new DubError(`Cannot move '${branch}' relative to itself.`, [
      'Pass a different branch name as the move target.',
    ]);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub move'.",
      'Run \'dub modify -am "<message>"\' to commit the changes first.',
    ]);
  }

  if (!(await branchExists(branch, cwd))) {
    throw new DubError(`Branch '${branch}' does not exist locally.`, [
      `Run 'git checkout -b ${branch}' to create the branch first.`,
      `Run 'git fetch && git checkout ${branch}' to pull it from the remote.`,
    ]);
  }
  if (!(await branchExists(target, cwd))) {
    throw new DubError(`Branch '${target}' does not exist locally.`, [
      `Run 'git checkout -b ${target}' to create the branch first.`,
      `Run 'git fetch && git checkout ${target}' to pull it from the remote.`,
    ]);
  }

  const state = await readState(cwd);
  const branchStack = findStackForBranch(state, branch);
  const targetStack = findStackForBranch(state, target);

  if (!branchStack) {
    throw new DubError(`Branch '${branch}' is not tracked.`, [
      `Run 'dub track ${branch} --parent <branch>' to track it first.`,
    ]);
  }
  if (!targetStack) {
    throw new DubError(`Branch '${target}' is not tracked.`, [
      `Run 'dub track ${target} --parent <branch>' to track it first.`,
    ]);
  }
  if (branchStack.id !== targetStack.id) {
    throw new DubError(
      `'${branch}' and '${target}' are tracked in different stacks.`,
      [
        `Run 'dub track ${branch} --parent <branch>' to move it into '${target}'s stack first.`,
        "Run 'dub log' to inspect the stacks.",
      ],
    );
  }

  const stack = branchStack;
  const branchEntry = stack.branches.find((b) => b.name === branch);
  const targetEntry = stack.branches.find((b) => b.name === target);
  if (!branchEntry || !targetEntry) {
    throw new DubError('Stack metadata is missing one of the branches.', [
      "Run 'dub doctor' to inspect the stack for damage.",
    ]);
  }

  if (branchEntry.type === 'root') {
    throw new DubError(`Cannot move root branch '${branch}'.`, [
      "Pick a non-root branch as <branch>; '--before'/'--after' reorders within a stack.",
    ]);
  }
  if (position === 'before' && targetEntry.type === 'root') {
    throw new DubError(`Cannot insert before root branch '${target}'.`, [
      "Pass '--after <target>' to insert below the root instead.",
      'Pick a non-root <target> if you intended to insert before it.',
    ]);
  }

  const reparents = planReparents({
    stack,
    branchEntry,
    targetEntry,
    position,
  });

  const dryRun = options.dryRun ?? false;
  if (reparents.length === 0) {
    const reason =
      position === 'before'
        ? `'${target}' is already a child of '${branch}'`
        : `'${branch}' is already the sole child of '${target}'`;
    return {
      branch,
      target,
      position,
      newParent: branchEntry.parent ?? '',
      reparented: [],
      rebased: [],
      retargeted: [],
      noOp: true,
      noOpReason: reason,
      dryRun,
    };
  }
  if (!dryRun) {
    await assertBranchesNotCheckedOutElsewhere(
      cwd,
      [branch, target, ...reparents.map((reparent) => reparent.branch)],
      'dub move',
    );
  }

  // Validate the planned mutation is acyclic on a clone before touching disk.
  const probeStack: Stack = structuredClone(stack);
  applyReparentsToStack(probeStack, reparents);
  try {
    assertAcyclic(probeStack);
  } catch {
    throw new DubError(
      `Moving '${branch}' ${position} '${target}' would create a cycle.`,
      [
        "Pick a <target> that isn't a descendant of <branch>.",
        "Run 'dub log' to inspect the current stack layout.",
      ],
    );
  }

  const originalBranch = await getCurrentBranch(cwd);
  const previousState = structuredClone(state);
  // Capture tips for every tracked branch (not just this stack). `restack`
  // can touch sibling stacks rooted at the same trunk when invoked from the
  // root, and the move undo entry must be able to reset them all.
  const previousBranchTips: Record<string, string> = {};
  for (const otherStack of state.stacks) {
    for (const entry of otherStack.branches) {
      if (entry.name in previousBranchTips) continue;
      previousBranchTips[entry.name] = await getBranchTip(entry.name, cwd);
    }
  }

  // Determine which branches may need PR retargeting. A reparented branch
  // whose PR base no longer matches its new parent is the obvious candidate;
  // we'll re-confirm against the live PR before issuing `gh pr edit`.
  const candidateRetargetBranches = reparents
    .map((r) => stack.branches.find((b) => b.name === r.branch))
    .filter((entry): entry is Branch => Boolean(entry?.pr_number));

  const plannedRetargets: Array<{ branch: string; newBase: string }> = [];
  if (!dryRun && candidateRetargetBranches.length > 0) {
    await ensureGhInstalled();
    await checkGhAuth();

    for (const entry of candidateRetargetBranches) {
      const reparent = reparents.find((r) => r.branch === entry.name);
      if (!reparent) continue;
      const info = await getBranchPrSyncInfo(entry.name, cwd);
      if (info.state !== 'OPEN') continue;
      if (info.baseRefName === reparent.newParent) continue;
      plannedRetargets.push({
        branch: entry.name,
        newBase: reparent.newParent,
      });
    }
  }

  if (dryRun) {
    return {
      branch,
      target,
      position,
      newParent:
        reparents.find((r) => r.branch === branch)?.newParent ??
        branchEntry.parent ??
        '',
      reparented: reparents.map((r) => r.branch),
      rebased: [],
      retargeted: candidateRetargetBranches.map((entry) => entry.name),
      noOp: false,
      dryRun: true,
    };
  }

  // The journal lets `dub continue` resume a half-applied move. We journal
  // every planned mutation BEFORE touching disk so the replay path can finish
  // anything we don't get to.
  const journal = await startCleanupJournal(cwd);

  for (const reparent of reparents) {
    await appendCleanupOperation(cwd, journal, {
      type: 'reparent',
      branch: reparent.branch,
      oldParent: reparent.oldParent,
      newParent: reparent.newParent,
    });
  }
  for (const retarget of plannedRetargets) {
    await appendCleanupOperation(cwd, journal, {
      type: 'retarget',
      branch: retarget.branch,
      newBase: retarget.newBase,
    });
  }

  applyReparentsToStack(stack, reparents);
  assertStateInvariants(state.stacks);
  await writeState(state, cwd);

  for (const retarget of plannedRetargets) {
    await retargetPrBase(retarget.branch, retarget.newBase, cwd);
  }

  // Save the move undo entry BEFORE clearing the cleanup journal AND BEFORE
  // invoking restack. Ordering matters for crash recovery: if we cleared the
  // journal first and crashed before saveUndoEntry, the user would have no
  // way to roll back (journal gone -> `dub continue` no-ops; undo entry
  // missing -> `dub undo` errors). `restack` receives `skipUndoEntry: true`
  // so the move undo entry isn't overwritten by restack's own undo write,
  // even when restack hits a conflict.
  await saveUndoEntry(
    {
      operation: 'move',
      timestamp: new Date().toISOString(),
      previousBranch: originalBranch,
      previousState,
      branchTips: previousBranchTips,
      createdBranches: [],
    },
    cwd,
  );

  await clearCleanupJournal(cwd);

  const restackResult = await restack(cwd, { skipUndoEntry: true });

  return {
    branch,
    target,
    position,
    newParent:
      reparents.find((r) => r.branch === branch)?.newParent ??
      branchEntry.parent ??
      '',
    reparented: reparents.map((r) => r.branch),
    rebased: restackResult.rebased,
    retargeted: plannedRetargets.map((r) => r.branch),
    noOp: false,
    ...(restackResult.status === 'conflict'
      ? { conflictBranch: restackResult.conflictBranch }
      : {}),
    dryRun: false,
  };
}

function planReparents(args: {
  stack: Stack;
  branchEntry: Branch;
  targetEntry: Branch;
  position: MovePosition;
}): ReparentPlan[] {
  const { stack, branchEntry, targetEntry, position } = args;
  const reparents: ReparentPlan[] = [];

  if (position === 'before') {
    // `<branch>` becomes `<target>`'s new parent; `<branch>` inherits target's
    // old parent. Other children of that old parent keep their parent pointer.
    if (targetEntry.parent === branchEntry.name) {
      // Target already child of branch — no-op.
      return [];
    }
    const newBranchParent = targetEntry.parent;
    if (newBranchParent == null) {
      // Non-root branches must have a non-null parent — the root check above
      // already rejected root targets, so reaching this branch means the
      // tracked state is inconsistent (e.g. a non-root entry with `parent:
      // null`). Surface it loudly instead of silently treating as a no-op.
      throw new DubError(
        `Branch '${targetEntry.name}' has corrupt metadata: non-root entry with no parent.`,
        [
          "Run 'dub doctor' to inspect the stack for damage.",
          `Run 'dub track ${targetEntry.name} --parent <branch>' to repair the parent link.`,
        ],
      );
    }
    if (branchEntry.parent !== newBranchParent) {
      reparents.push({
        branch: branchEntry.name,
        oldParent: branchEntry.parent,
        newParent: newBranchParent,
      });
    }
    reparents.push({
      branch: targetEntry.name,
      oldParent: targetEntry.parent,
      newParent: branchEntry.name,
    });
    return reparents;
  }

  // position === 'after'
  // `<branch>` becomes a child of `<target>`. Existing children of `<target>`
  // (other than `<branch>` itself) become children of `<branch>` so we
  // preserve the "insert between" semantics rather than dropping them.
  const branchDescendants = new Set(getDescendants(stack, branchEntry.name));
  const otherTargetChildren = stack.branches.filter(
    (entry) =>
      entry.parent === targetEntry.name &&
      entry.name !== branchEntry.name &&
      !branchDescendants.has(entry.name),
  );

  if (
    branchEntry.parent === targetEntry.name &&
    otherTargetChildren.length === 0
  ) {
    return [];
  }

  if (branchEntry.parent !== targetEntry.name) {
    reparents.push({
      branch: branchEntry.name,
      oldParent: branchEntry.parent,
      newParent: targetEntry.name,
    });
  }
  for (const child of otherTargetChildren) {
    reparents.push({
      branch: child.name,
      oldParent: targetEntry.name,
      newParent: branchEntry.name,
    });
  }
  return reparents;
}

function applyReparentsToStack(stack: Stack, reparents: ReparentPlan[]): void {
  const byName = new Map(stack.branches.map((entry) => [entry.name, entry]));
  for (const reparent of reparents) {
    const entry = byName.get(reparent.branch);
    if (!entry) continue;
    entry.parent = reparent.newParent;
    // Leave `parent_revision` untouched: it tracks the commit branch was last
    // rebased onto, which is still on the branch's ancestry after a parent
    // pointer change. Restack uses it as the rebase upstream and falls back to
    // `merge-base` if it's null — matching `dub track`'s reparenting behavior.
  }
}
