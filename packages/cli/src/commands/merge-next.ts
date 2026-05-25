import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import {
  type AllPrSyncInfoBatch,
  type BranchPrLifecycleState,
  checkGhAuth,
  enqueuePrToMergeQueue,
  ensureGhInstalled,
  getAllPrSyncInfoBatch,
  getBranchMergeQueueStatus,
  getBranchPrSyncInfo,
  getPr,
  getPrMergeStatusByNumber,
  mergePr,
  type PrInfo,
  type PrMergeStatus,
  retargetPrBase,
} from '../lib/github';
import type { Branch, Stack } from '../lib/state';
import { type PostMergeResult, postMerge } from './post-merge';
import { getSubmitPlan } from './submit';

export interface MergeNextResult {
  dryRun: boolean;
  mergedBranch: string;
  prNumber: number;
  preMergeRetargeted: string[];
  /** Other open + mergeable candidates at the same stack depth as the target. */
  siblingCandidates: string[];
  /** Open siblings at the chosen depth whose PR is not MERGEABLE. */
  blockedSiblings: BlockedSibling[];
  mode: 'direct' | 'queue';
  postMerge?: PostMergeResult;
}

export interface BlockedSibling {
  branch: string;
  prNumber: number;
  mergeable: string;
  mergeStateStatus: string;
}

const MERGEABLE = 'MERGEABLE';
const UNKNOWN = 'UNKNOWN';

interface EvaluatedCandidate {
  branch: Branch;
  pr: PrInfo;
  status: PrMergeStatus;
}

interface TargetSelection {
  chosen?: { branch: Branch; pr: PrInfo };
  siblings: string[];
  blockedSiblings: BlockedSibling[];
  unresolvedAtFirstDepth: EvaluatedCandidate[];
}

export async function mergeNext(
  cwd: string,
  options: {
    dryRun?: boolean;
    method?: 'merge' | 'squash' | 'rebase';
    queue?: boolean;
    restack?: boolean;
    submit?: boolean;
  } = {},
): Promise<MergeNextResult> {
  await ensureGhInstalled();
  await checkGhAuth();

  const plan = await getSubmitPlan(cwd, { stack: true });
  const queueMode = await resolveQueueMode(cwd, plan.rootBranch, options.queue);
  const batch = await getAllPrSyncInfoBatch(cwd);
  const depthByName = computeDepths(plan.stack);
  const currentPathSet = currentPathBranchNames(plan.stack, plan.currentBranch);

  const selection = await selectMergeTarget({
    plan,
    batch,
    depthByName,
    currentPathSet,
    cwd,
  });

  if (!selection.chosen) {
    if (selection.unresolvedAtFirstDepth.length > 0) {
      throw unresolvedCandidateError(selection.unresolvedAtFirstDepth);
    }
    throw new DubError('No mergeable branch found in the stack.', [
      "Run 'dub ss' to push branches and create PRs for the stack.",
      "Run 'dub log' to inspect the stack and confirm PRs exist.",
    ]);
  }

  const { branch: chosenBranch, pr: chosenPr } = selection.chosen;
  const nextParent = chosenBranch.parent;
  if (!nextParent) {
    throw new DubError(`Branch '${chosenBranch.name}' has no tracked parent.`, [
      `Run 'dub track ${chosenBranch.name} --parent <branch>' to set the parent.`,
      "Run 'dub doctor' to inspect the stack for related issues.",
    ]);
  }

  const directChildren = plan.stack.branches
    .filter(
      (branch) => branch.type !== 'root' && branch.parent === chosenBranch.name,
    )
    .map((branch) => branch.name)
    .sort();
  const childBranchesWithOpenPr: string[] = [];
  if (!queueMode) {
    for (const childBranch of directChildren) {
      const childPr = await getPr(childBranch, cwd);
      if (childPr) childBranchesWithOpenPr.push(childBranch);
    }
  }

  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    return {
      dryRun: true,
      mergedBranch: chosenBranch.name,
      prNumber: chosenPr.number,
      preMergeRetargeted: childBranchesWithOpenPr,
      siblingCandidates: selection.siblings,
      blockedSiblings: selection.blockedSiblings,
      mode: queueMode ? 'queue' : 'direct',
    };
  }

  if (queueMode) {
    await enqueuePrToMergeQueue(chosenPr.number, cwd, {
      method: options.method ?? 'squash',
    });
    return {
      dryRun: false,
      mergedBranch: chosenBranch.name,
      prNumber: chosenPr.number,
      preMergeRetargeted: [],
      siblingCandidates: selection.siblings,
      blockedSiblings: selection.blockedSiblings,
      mode: 'queue',
    };
  }

  // Journal the pre-merge retargets so a crash mid-loop can be replayed by
  // `dub continue` — without it, half-retargeted child PRs would be left
  // pointing at a branch that's about to be merged and deleted.
  if (childBranchesWithOpenPr.length > 0) {
    const journal = await startCleanupJournal(cwd);
    for (const childBranch of childBranchesWithOpenPr) {
      await appendCleanupOperation(cwd, journal, {
        type: 'retarget',
        branch: childBranch,
        newBase: nextParent,
      });
      await retargetPrBase(childBranch, nextParent, cwd);
    }
    await clearCleanupJournal(cwd);
  }
  await mergePr(chosenPr.number, cwd, {
    method: options.method ?? 'squash',
    deleteBranch: true,
  });
  const maintenance = await postMerge(cwd, {
    dryRun: false,
    restack: options.restack ?? true,
    submit: options.submit ?? true,
  });
  return {
    dryRun: false,
    mergedBranch: chosenBranch.name,
    prNumber: chosenPr.number,
    preMergeRetargeted: childBranchesWithOpenPr,
    siblingCandidates: selection.siblings,
    blockedSiblings: selection.blockedSiblings,
    mode: 'direct',
    postMerge: maintenance,
  };
}

async function resolveQueueMode(
  cwd: string,
  trunk: string,
  requested: boolean | undefined,
): Promise<boolean> {
  if (requested === false) return false;
  const status = await getBranchMergeQueueStatus(trunk, cwd);
  if (status.mergeQueueEnabled) return true;
  if (requested === true) {
    throw new DubError(
      `GitHub merge queue is not enabled for trunk branch '${trunk}'.`,
      [
        `Enable a merge queue in GitHub branch protection or rulesets for '${trunk}', then retry.`,
        "Run 'dub merge-next --no-queue' to force the direct merge path.",
      ],
    );
  }
  return false;
}

function computeDepths(stack: Stack): Map<string, number> {
  const depths = new Map<string, number>();
  const root = stack.branches.find((b) => b.type === 'root');
  if (!root) return depths;

  const childMap = new Map<string, Branch[]>();
  for (const branch of stack.branches) {
    if (!branch.parent) continue;
    const arr = childMap.get(branch.parent) ?? [];
    arr.push(branch);
    childMap.set(branch.parent, arr);
  }
  for (const arr of childMap.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  depths.set(root.name, 0);
  const queue: Array<{ branch: Branch; depth: number }> = [
    { branch: root, depth: 0 },
  ];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    const children = childMap.get(node.branch.name) ?? [];
    for (const child of children) {
      depths.set(child.name, node.depth + 1);
      queue.push({ branch: child, depth: node.depth + 1 });
    }
  }
  return depths;
}

function currentPathBranchNames(
  stack: Stack,
  currentBranch: string,
): Set<string> {
  const names = new Set<string>();
  const map = new Map(stack.branches.map((b) => [b.name, b]));
  let cursor = map.get(currentBranch);
  while (cursor) {
    if (names.has(cursor.name)) break;
    names.add(cursor.name);
    if (!cursor.parent) break;
    cursor = map.get(cursor.parent);
  }
  return names;
}

async function selectMergeTarget(args: {
  plan: Awaited<ReturnType<typeof getSubmitPlan>>;
  batch: AllPrSyncInfoBatch;
  depthByName: Map<string, number>;
  currentPathSet: Set<string>;
  cwd: string;
}): Promise<TargetSelection> {
  const { plan, batch, depthByName, currentPathSet, cwd } = args;
  const branchByName = new Map(plan.stack.branches.map((b) => [b.name, b]));

  const branchesByDepth = new Map<number, Branch[]>();
  for (const branch of plan.branches) {
    const depth = depthByName.get(branch.name);
    if (depth === undefined) continue;
    const arr = branchesByDepth.get(depth) ?? [];
    arr.push(branch);
    branchesByDepth.set(depth, arr);
  }
  const sortedDepths = [...branchesByDepth.keys()].sort((a, b) => a - b);

  for (const depth of sortedDepths) {
    const branches = (branchesByDepth.get(depth) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const evaluated: EvaluatedCandidate[] = [];

    for (const branch of branches) {
      const parentName = branch.parent;
      if (!parentName) continue;
      const parentBranch = branchByName.get(parentName);
      const parentIsRoot = parentBranch?.type === 'root';
      if (!parentIsRoot) {
        const parentLifecycle = await lifecycleForBranch(
          parentName,
          batch,
          cwd,
        );
        if (parentLifecycle !== 'MERGED') continue;
      }

      const lifecycle = await lifecycleForBranch(branch.name, batch, cwd);
      if (lifecycle !== 'OPEN') continue;

      const pr = await getPr(branch.name, cwd);
      if (!pr) continue;

      const status = await getPrMergeStatusByNumber(pr.number, cwd);
      evaluated.push({ branch, pr, status });
    }

    if (evaluated.length === 0) continue;

    const mergeable = evaluated.filter((c) => c.status.mergeable === MERGEABLE);
    if (mergeable.length === 0) {
      // Lowest depth with candidates has none mergeable. Never descend past
      // this floor: even if a deeper child's parent eligibility somehow
      // passed, merging it ahead of its non-mergeable ancestor would corrupt
      // stack ordering.
      return {
        siblings: [],
        blockedSiblings: [],
        unresolvedAtFirstDepth: evaluated,
      };
    }

    const onCurrentPath = mergeable.filter((c) =>
      currentPathSet.has(c.branch.name),
    );
    const chosen = onCurrentPath[0] ?? mergeable[0];
    const siblings = mergeable
      .filter((c) => c.branch.name !== chosen.branch.name)
      .map((c) => c.branch.name);
    const blockedSiblings: BlockedSibling[] = evaluated
      .filter((c) => c.status.mergeable !== MERGEABLE)
      .map((c) => ({
        branch: c.branch.name,
        prNumber: c.pr.number,
        mergeable: c.status.mergeable ?? UNKNOWN,
        mergeStateStatus: c.status.mergeStateStatus ?? 'unknown',
      }));
    return {
      chosen: { branch: chosen.branch, pr: chosen.pr },
      siblings,
      blockedSiblings,
      unresolvedAtFirstDepth: [],
    };
  }

  return { siblings: [], blockedSiblings: [], unresolvedAtFirstDepth: [] };
}

async function lifecycleForBranch(
  branch: string,
  batch: AllPrSyncInfoBatch,
  cwd: string,
): Promise<BranchPrLifecycleState> {
  const cached = batch.byBranch.get(branch);
  if (cached) return cached.state;
  if (batch.truncated) {
    const info = await getBranchPrSyncInfo(branch, cwd);
    return info.state;
  }
  return 'NONE';
}

function unresolvedCandidateError(candidates: EvaluatedCandidate[]): DubError {
  const blocked = candidates.filter(
    (c) => c.status.mergeable !== MERGEABLE && c.status.mergeable !== UNKNOWN,
  );
  const unknown = candidates.filter((c) => c.status.mergeable === UNKNOWN);
  const summarize = (entry: EvaluatedCandidate) => {
    const mergeable = entry.status.mergeable ?? UNKNOWN;
    const state = entry.status.mergeStateStatus ?? 'unknown';
    return `'${entry.branch.name}' (PR #${entry.pr.number}: mergeable=${mergeable}, state=${state})`;
  };
  // Pure-UNKNOWN floor: GitHub hasn't finished computing mergeability yet.
  // Direct users to retry, not to chase phantom check failures.
  if (blocked.length === 0 && unknown.length > 0) {
    return new DubError(
      `GitHub has not yet computed mergeability for this stack level: ${unknown.map(summarize).join('; ')}.`,
      [
        'Retry in a few seconds — GitHub computes mergeability asynchronously after each push.',
        "Run 'gh pr view <number> --json mergeable,mergeStateStatus' to confirm the live status.",
      ],
    );
  }
  return new DubError(
    `No mergeable PR at this stack level. Blocked: ${candidates.map(summarize).join('; ')}.`,
    [
      "Run 'gh pr view <number> --web' to inspect required checks and reviews.",
      "Run 'dub sync' to reconcile remote drift, then 'dub submit' to refresh.",
      'Retry once required checks pass or approvals are granted.',
    ],
  );
}
