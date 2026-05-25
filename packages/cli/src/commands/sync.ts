import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import {
  type AiPromptChoice,
  isAiPromptOptionEnabled,
  resolveAiPromptDecision,
} from '../lib/ai-prompt-decision';
import { appendCheckoutHistory } from '../lib/checkout-history';
import {
  appendCleanupOperation,
  type CleanupDeleteOp,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import { execa } from '../lib/exec';
import {
  branchExists,
  checkoutBranch,
  checkoutRemoteBranch,
  clearStaleNamespacedFetchRefs,
  deleteBranch,
  fastForwardBranchToRef,
  fetchBranches,
  formatWorktreeCheckoutSkipMessage,
  getBranchTip,
  getCurrentBranch,
  getRefSha,
  hardResetBranchToRef,
  hasUniquePatchCommits,
  isAncestor,
  listWorktreeCheckouts,
  pruneRemote,
  rebaseBranchOntoRef,
  remoteBranchExists,
} from '../lib/git';
import { isMergedByPatchId } from '../lib/git/is-merged-by-patch-id';
import type { BranchPrSyncInfo } from '../lib/github';
import {
  checkGhAuth,
  ensureGhInstalled,
  getAllPrSyncInfoBatch,
  getBranchPrSyncInfo,
} from '../lib/github';
import { detectActiveOperation } from '../lib/operation-state';
import { createProgress, getActiveProgress } from '../lib/progress';
import {
  resolveRestackConflictDecision,
  restackConflictPrompt,
} from '../lib/restack-conflict-prompt';
import { rollbackRestack } from '../lib/restack-rollback';
import {
  type Branch,
  type DubState,
  findStackForBranch,
  getConfiguredTrunks,
  getStackTrunk,
  readState,
  writeState,
} from '../lib/state';
import { classifyBranchSyncStatus } from '../lib/sync/branch-status';
import { buildCleanupPlan } from '../lib/sync/cleanup';
import { partitionFreshBranches } from '../lib/sync/fresh';
import { resolveReconcileDecision } from '../lib/sync/reconcile';
import { reconcilePrompt } from '../lib/sync/reconcile-prompt';
import { printBranchOutcome, printSyncSummary } from '../lib/sync/report';
import type {
  BranchSyncOutcome,
  BranchSyncStatus,
  ReconcileSource,
  ReconcileSourceHistogram,
  SyncOptions,
  SyncResult,
} from '../lib/sync/types';
import { saveUndoEntry } from '../lib/undo-log';
import { aiResolve } from './ai-resolve';
import { restack } from './restack';
import {
  hasNonRootBranches,
  resolvePreferredBranch,
  retargetOpenPrBranches,
  submitRefreshedStacks,
} from './stack-maintenance';

/**
 * Marker DubError for the `abort` reconcile decision. Used to bypass DUB-13's
 * per-branch failure-isolation catch so an abort halts the entire sync.
 *
 * The decision can be reached two ways and the message reflects which:
 * - User picks "Abort this command" in the interactive three-way prompt.
 * - `--no-interactive` without `--force` falls back to ABORT as the
 *   safest non-interactive default.
 */
class SyncAbortError extends DubError {
  constructor(branch: string, interactive: boolean) {
    const message = interactive
      ? `Sync aborted by user while reconciling '${branch}'.`
      : `Sync aborted while reconciling '${branch}': prompting is disabled (--no-interactive) and no --force was given, so the safe default is to abort.`;
    super(message, [
      "Run 'dub sync' again interactively to choose between rebase/take-remote/abort.",
      "Pass '--force --no-interactive' to take the remote version without prompting.",
      "Pass '--force' alone if you want the prompt but a fallback take-remote on --no-interactive shells.",
    ]);
    this.name = 'SyncAbortError';
  }
}

async function recordSyncUndo(
  cwd: string,
  state: DubState,
  originalBranch: string,
): Promise<void> {
  const branchTips: Record<string, string> = {};
  const names = new Set<string>();
  for (const stack of state.stacks) {
    for (const branch of stack.branches) {
      names.add(branch.name);
    }
  }
  for (const name of names) {
    if (await branchExists(name, cwd)) {
      try {
        branchTips[name] = await getBranchTip(name, cwd);
      } catch {
        // Branch tip unreadable; skip.
      }
    }
  }
  await saveUndoEntry(
    {
      operation: 'sync',
      timestamp: new Date().toISOString(),
      previousBranch: originalBranch,
      previousState: structuredClone(state),
      branchTips,
      createdBranches: [],
      summary: `sync ${state.stacks.length} stack(s)`,
    },
    cwd,
  );
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirm(question: string): Promise<boolean> {
  const progress = getActiveProgress();
  if (progress) progress.pause();
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [Y/n] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
    if (progress) progress.resume();
  }
}

async function choose(
  question: string,
  choices: Array<{ label: string; value: string }>,
  invalidFallback?: string,
): Promise<string> {
  const progress = getActiveProgress();
  if (progress) progress.pause();
  const rl = readline.createInterface({ input, output });
  try {
    console.log(question);
    for (let i = 0; i < choices.length; i++) {
      console.log(`  ${i + 1}. ${choices[i].label}`);
    }
    const answer = await rl.question('Select option: ');
    const idx = Number.parseInt(answer.trim(), 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= choices.length) {
      return invalidFallback ?? choices[choices.length - 1].value;
    }
    return choices[idx].value;
  } finally {
    rl.close();
    if (progress) progress.resume();
  }
}

async function canShowAiPrompt(cwd: string): Promise<boolean> {
  try {
    return await isAiPromptOptionEnabled(cwd);
  } catch {
    return false;
  }
}

const RECONCILE_AI_CHOICES: Array<
  AiPromptChoice<'rebase-onto-remote' | 'take-remote' | 'abort'>
> = [
  {
    label: 'Rebase your changes on top of the remote version',
    value: 'rebase-onto-remote',
  },
  {
    label: 'Overwrite the local copy with the remote version',
    value: 'take-remote',
  },
  {
    label: 'Abort this command',
    value: 'abort',
  },
];

const UNSUBMITTED_AI_CHOICES: Array<
  AiPromptChoice<'remote' | 'local' | 'skip'>
> = [
  {
    label: 'Overwrite the local copy with the remote version',
    value: 'remote',
  },
  {
    label: 'Keep the local branch',
    value: 'local',
  },
  {
    label: 'Skip for now',
    value: 'skip',
  },
];

const PARENT_MISMATCH_AI_CHOICES: Array<
  AiPromptChoice<'remote' | 'local' | 'skip'>
> = [
  {
    label: 'Take remote version and remote parent',
    value: 'remote',
  },
  {
    label: 'Keep local branch and parent',
    value: 'local',
  },
  {
    label: 'Skip for now',
    value: 'skip',
  },
];

async function resolveUnsubmittedDecision(input: {
  cwd: string;
  branch: string;
  remoteRef: string;
  localParent: string | null;
  showAiPromptOptions: boolean;
}): Promise<'remote' | 'local' | 'skip'> {
  const manualPrompt = async (): Promise<'remote' | 'local' | 'skip'> => {
    if (!input.showAiPromptOptions) {
      const takeRemote = await confirm(
        `Branch '${input.branch}' has no DubStack submit baseline. Overwrite local with remote version?`,
      );
      return takeRemote ? 'remote' : 'local';
    }

    return choose(
      `Branch '${input.branch}' has no DubStack submit baseline. How would you like to handle it?`,
      [
        {
          label: 'Overwrite the local copy with the remote version',
          value: 'remote',
        },
        { label: 'Keep local branch', value: 'local' },
        { label: 'Skip for now', value: 'skip' },
      ],
    ) as Promise<'remote' | 'local' | 'skip'>;
  };

  if (!input.showAiPromptOptions) return manualPrompt();

  const firstChoice = await choose(
    `Branch '${input.branch}' has no DubStack submit baseline. How would you like to handle it?`,
    [
      {
        label: 'Overwrite the local copy with the remote version',
        value: 'remote',
      },
      { label: 'Keep local branch', value: 'local' },
      { label: 'Skip for now', value: 'skip' },
      {
        label: 'Let AI decide (shows reasoning before applying)',
        value: 'ai',
      },
    ],
    'local',
  );
  if (firstChoice !== 'ai') return firstChoice as 'remote' | 'local' | 'skip';

  return resolveAiPromptDecision<'remote' | 'local' | 'skip'>({
    cwd: input.cwd,
    scenario: 'unsubmitted branch divergence',
    subject: input.branch,
    choices: UNSUBMITTED_AI_CHOICES,
    context: await buildBranchAiPromptContext({
      cwd: input.cwd,
      branch: input.branch,
      remoteRef: input.remoteRef,
      localParent: input.localParent,
      status: 'unsubmitted',
      includePrComments: false,
    }),
    fallbackPrompt: manualPrompt,
  });
}

async function resolveParentMismatchDecision(input: {
  cwd: string;
  branch: string;
  remoteRef: string;
  localParent: string | null;
  remoteParent: string | null;
  showAiPromptOptions: boolean;
}): Promise<'remote' | 'local' | 'skip'> {
  const manualPrompt = () =>
    choose(
      `Branch '${input.branch}' parent differs locally ('${input.localParent}') vs remote ('${input.remoteParent}').`,
      PARENT_MISMATCH_AI_CHOICES.map((choice) => ({
        label: choice.label,
        value: choice.value,
      })),
    ) as Promise<'remote' | 'local' | 'skip'>;

  if (!input.showAiPromptOptions) return manualPrompt();

  const firstChoice = await choose(
    `Branch '${input.branch}' parent differs locally ('${input.localParent}') vs remote ('${input.remoteParent}').`,
    [
      ...PARENT_MISMATCH_AI_CHOICES.map((choice) => ({
        label: choice.label,
        value: choice.value,
      })),
      {
        label: 'Let AI decide (shows reasoning before applying)',
        value: 'ai',
      },
    ],
    'skip',
  );
  if (firstChoice !== 'ai') {
    return firstChoice as 'remote' | 'local' | 'skip';
  }

  return resolveAiPromptDecision<'remote' | 'local' | 'skip'>({
    cwd: input.cwd,
    scenario: 'remote parent mismatch',
    subject: input.branch,
    choices: PARENT_MISMATCH_AI_CHOICES,
    context: await buildBranchAiPromptContext({
      cwd: input.cwd,
      branch: input.branch,
      remoteRef: input.remoteRef,
      localParent: input.localParent,
      remoteParent: input.remoteParent,
      status: 'needs-remote-sync',
      includePrComments: false,
    }),
    fallbackPrompt: manualPrompt,
  });
}

async function buildBranchAiPromptContext(input: {
  cwd: string;
  branch: string;
  remoteRef: string;
  localParent: string | null;
  remoteParent?: string | null;
  status: BranchSyncStatus;
  includePrComments: boolean;
}): Promise<string> {
  const sections = [
    `Branch: ${input.branch}`,
    `Status: ${input.status}`,
    `Local parent: ${input.localParent ?? '(none)'}`,
    `Remote parent: ${input.remoteParent ?? '(same or unknown)'}`,
    '',
    'Recent local commits:',
    await safeGitOutput(input.cwd, ['log', '--oneline', '-5', input.branch]),
    '',
    'Recent remote commits:',
    await safeGitOutput(input.cwd, ['log', '--oneline', '-5', input.remoteRef]),
    '',
    'Local vs remote diff stat:',
    await safeGitOutput(input.cwd, [
      'diff',
      '--stat',
      input.remoteRef,
      input.branch,
    ]),
    '',
    'Remote vs local diff stat:',
    await safeGitOutput(input.cwd, [
      'diff',
      '--stat',
      input.branch,
      input.remoteRef,
    ]),
  ];

  if (input.localParent) {
    sections.push(
      '',
      'Parent branch recent commits:',
      await safeGitOutput(input.cwd, [
        'log',
        '--oneline',
        '-5',
        input.localParent,
      ]),
    );
  }

  if (input.includePrComments) {
    sections.push(
      '',
      'Latest PR comments:',
      await safeGitOutput(
        input.cwd,
        [
          'pr',
          'view',
          input.branch,
          '--json',
          'comments',
          '--jq',
          '.comments[-5:] | map(.author.login + ": " + .body) | join("\\n---\\n")',
        ],
        'gh',
      ),
    );
  }

  return sections.join('\n');
}

async function safeGitOutput(
  cwd: string,
  args: string[],
  command = 'git',
): Promise<string> {
  try {
    const { stdout } = await execa(command, args, { cwd });
    return stdout.trim() || '(none)';
  } catch {
    return '(unavailable)';
  }
}

export async function sync(
  cwd: string,
  rawOptions: {
    restack?: boolean;
    force?: boolean;
    all?: boolean;
    interactive?: boolean;
    fresh?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<SyncResult> {
  const dryRun = rawOptions.dryRun ?? false;
  if (!dryRun) {
    await ensureGhInstalled();
    await checkGhAuth();
  }

  const options: SyncOptions = {
    restack: rawOptions.restack ?? true,
    force: rawOptions.force ?? false,
    all: rawOptions.all ?? false,
    interactive: rawOptions.interactive ?? isInteractiveShell(),
    fresh: rawOptions.fresh ?? false,
    dryRun,
  };
  const showAiPromptOptions = options.interactive
    ? await canShowAiPrompt(cwd)
    : false;

  const state = await readState(cwd);
  const originalBranch = await getCurrentBranch(cwd);
  const worktreeCheckouts = await listWorktreeCheckouts(cwd);
  const progress = createProgress();

  const scopeStacks = options.all
    ? state.stacks
    : (() => {
        const stack = findStackForBranch(state, originalBranch);
        if (!stack) {
          throw new DubError(
            `Branch '${originalBranch}' is not part of any stack.`,
            [
              "Run 'dub create <branch>' to start a stack from this branch.",
              "Run 'dub track <branch>' to track this branch under an existing parent.",
              "Run 'dub sync --all' to sync every tracked stack instead.",
            ],
          );
        }
        return [stack];
      })();
  const stateBranchMap = new Map<string, Branch>(
    scopeStacks.flatMap((stack) => stack.branches.map((b) => [b.name, b])),
  );
  const frozenBranches = new Set(
    [...stateBranchMap.values()]
      .filter((branch) => branch.frozen && branch.type !== 'root')
      .map((branch) => branch.name),
  );

  // Real trunks only. `detached_root` entries are feature branches that `dub
  // unlink` promoted to a root in their own stack — running the trunk
  // fast-forward loop against them would `git branch -f <feat> origin/<feat>`
  // and silently overwrite local commits when `--force` is set.
  const roots = Array.from(
    new Set(
      options.all
        ? getConfiguredTrunks(state)
        : scopeStacks
            .map((stack) => {
              if (stack.trunk) return stack.trunk;
              const root = stack.branches.find(
                (branch) => branch.type === 'root',
              );
              return root?.detached_root ? undefined : root?.name;
            })
            .filter((root): root is string => Boolean(root)),
    ),
  );
  const stackBranches = Array.from(
    new Set(
      scopeStacks
        .flatMap((s) => s.branches)
        .filter((b) => b.type !== 'root')
        .map((b) => b.name),
    ),
  );

  const result: SyncResult = {
    fetched: [],
    trunksSynced: [],
    cleaned: [],
    branches: [],
    restacked: false,
    reconcileSources: {},
    dryRun,
  };

  if (dryRun) {
    return {
      ...result,
      plannedScope: {
        roots: Array.from(roots),
        branches: Array.from(stackBranches),
      },
    };
  }
  const rootHasRemote = new Map<string, boolean>();
  let pendingError: Error | null = null;
  let restoreTarget = originalBranch;
  let needsSubmitRefresh = false;
  let restackChanged = false;
  let restackCancelled = false;
  const reparentedBranchNames = new Set<string>();
  const reparentedDueToMergedParent = new Set<string>();
  const worktreeSkippedBranches = new Set<string>();
  const recordWorktreeSkip = (branch: string): boolean => {
    const worktreePath = worktreeCheckouts.get(branch);
    if (!worktreePath) return false;
    if (worktreeSkippedBranches.has(branch)) return true;

    const outcome: BranchSyncOutcome = {
      branch,
      status: 'checked-out-elsewhere',
      action: 'skipped',
      message: formatWorktreeCheckoutSkipMessage(branch, worktreePath),
    };
    worktreeSkippedBranches.add(branch);
    result.branches.push(outcome);
    printBranchOutcome(outcome);
    return true;
  };

  try {
    const allTrackedBranches = new Set(
      state.stacks.flatMap((s) => s.branches.map((b) => b.name)),
    );
    await clearStaleNamespacedFetchRefs(allTrackedBranches, cwd);

    const partition = partitionFreshBranches({
      branches: stackBranches,
      branchMap: stateBranchMap,
      fresh: options.fresh,
      now: Date.now(),
    });
    const freshSkipped = new Set(
      partition.canSkip.filter((branch) => !frozenBranches.has(branch)),
    );

    console.log('🌲 Fetching branches from remote...');
    const toFetch = [
      ...new Set([
        ...roots,
        ...partition.mustFetch.filter((branch) => !frozenBranches.has(branch)),
      ]),
    ];
    // Record the undo snapshot just before the first remote/git mutation
    // (here, the fetch). Earlier sites would have polluted the undo ring
    // if scope validation threw without making any changes.
    await recordSyncUndo(cwd, state, originalBranch);
    if (toFetch.length > 0) {
      progress.start('🌲 Fetching branches', toFetch.length);
      await fetchBranches(toFetch, cwd, 'origin', {
        onBranchStart: (index, branch) => {
          progress.update('🌲 Fetching branches', index, branch);
        },
      });
      progress.complete('🌲 Fetching branches');
      result.fetched = toFetch;
    }
    if (freshSkipped.size > 0) {
      console.log(
        `⚡ Reusing recent fetch for ${freshSkipped.size} branch(es) synced < 5min ago (use --fresh to refetch).`,
      );
    }

    await pruneRemote('origin', cwd);

    for (const root of roots) {
      if (recordWorktreeSkip(root)) continue;

      const remoteRef = `origin/${root}`;
      const hasRemoteRoot = await remoteBranchExists(root, cwd);
      rootHasRemote.set(root, hasRemoteRoot);
      if (!hasRemoteRoot) continue;

      const ff = await fastForwardBranchToRef(root, remoteRef, cwd);
      if (ff) {
        result.trunksSynced.push(root);
        continue;
      }

      if (options.force) {
        await hardResetBranchToRef(root, remoteRef, cwd);
        result.trunksSynced.push(root);
        continue;
      }

      if (options.interactive) {
        const takeRemote = await confirm(
          `Trunk '${root}' cannot be fast-forwarded. Overwrite local trunk with '${remoteRef}'?`,
        );
        if (takeRemote) {
          await hardResetBranchToRef(root, remoteRef, cwd);
          result.trunksSynced.push(root);
        }
      }
    }

    console.log('🧹 Cleaning up branches with merged/closed PRs...');
    const localTrackedBranches: string[] = [];
    for (const branch of stackBranches) {
      if (frozenBranches.has(branch)) continue;
      const hasLocal = await branchExists(branch, cwd);
      if (hasLocal) localTrackedBranches.push(branch);
    }
    // Skip the gh round-trip when there are no non-root branches to look up
    // (e.g. a stack containing only a root branch).
    const prBatch =
      stackBranches.length > 0
        ? await getAllPrSyncInfoBatch(cwd)
        : { byBranch: new Map<string, BranchPrSyncInfo>(), truncated: false };
    const lookupPrSyncInfo = async (
      branch: string,
    ): Promise<BranchPrSyncInfo> => {
      const cached = prBatch.byBranch.get(branch);
      if (cached) return cached;
      if (prBatch.truncated) return getBranchPrSyncInfo(branch, cwd);
      return { state: 'NONE', baseRefName: null };
    };
    const parentOf = new Map<string, string | null>();
    for (const stack of scopeStacks) {
      for (const node of stack.branches) {
        parentOf.set(node.name, node.parent);
      }
    }
    const cleanupPlan = await buildCleanupPlan({
      branches: localTrackedBranches,
      parentOf,
      force: options.force,
      getPrStatus: async (branch) => (await lookupPrSyncInfo(branch)).state,
      isMergedIntoAnyRoot: async (branch) => {
        for (const root of roots) {
          const compareRef = rootHasRemote.get(root) ? `origin/${root}` : root;
          if (await isAncestor(branch, compareRef, cwd)) return true;
        }
        return false;
      },
      isMergedByPatchId: async (branch) => {
        for (const root of roots) {
          const trunkRef = rootHasRemote.get(root) ? `origin/${root}` : root;
          if (await isMergedByPatchId(branch, trunkRef, cwd)) return true;
        }
        return false;
      },
      isEmpty: async (branch, parent) => {
        if (parent == null) return false;
        try {
          return !(await hasUniquePatchCommits(parent, branch, cwd));
        } catch {
          // If we can't tell, err on the side of NOT deleting.
          return false;
        }
      },
    });
    const excludedFromSync = new Set<string>();
    for (const skipped of cleanupPlan.skipped) {
      if (skipped.reason === 'commits-not-in-trunk') {
        excludedFromSync.add(skipped.branch);
        for (const child of getDescendants(scopeStacks, skipped.branch)) {
          excludedFromSync.add(child);
        }
      }
    }
    // Map "branches that got reparented away from X" → used both for the
    // auto-clean warning ("X had dependent branches: …") and for marking
    // parent-merged orphans below.
    const reparentedFromBranch = new Map<string, string[]>();
    for (const op of cleanupPlan.operations) {
      if (op.type !== 'reparent' || op.oldParent == null) continue;
      const arr = reparentedFromBranch.get(op.oldParent) ?? [];
      arr.push(op.branch);
      reparentedFromBranch.set(op.oldParent, arr);
    }
    const deleteOpByBranch = new Map<string, CleanupDeleteOp>();
    for (const op of cleanupPlan.operations) {
      if (op.type === 'delete') deleteOpByBranch.set(op.branch, op);
    }

    // The journal is intentionally not wrapped in a try/catch: when an
    // operation throws, we want it left on disk so `dub continue` can replay
    // the remaining work. Clearing only happens on the success path below.
    const cleanupJournal = await startCleanupJournal(cwd);
    // The progress bar tracks delete ops only — reparents are bookkeeping
    // and don't carry the same "work in flight" semantics for the user.
    if (cleanupPlan.toDelete.length > 0) {
      progress.start('🧹 Cleaning merged', cleanupPlan.toDelete.length);
    }
    let cleanupIndex = 0;
    for (const op of cleanupPlan.operations) {
      if (op.type === 'reparent') {
        // Reparents are pure state maintenance — apply them even when the
        // child is in `excludedFromSync` (the exclusion only suppresses the
        // per-branch sync reconciliation step). Skipping here would leave
        // `branch.parent` pointing at an ancestor that another op is about
        // to delete, breaking stack connectivity.
        await appendCleanupOperation(cwd, cleanupJournal, op);
        const stateEntry = stateBranchMap.get(op.branch);
        if (stateEntry) stateEntry.parent = op.newParent;
        reparentedBranchNames.add(op.branch);
        if (op.oldParent != null) {
          const oldParentDelete = deleteOpByBranch.get(op.oldParent);
          if (
            oldParentDelete &&
            (oldParentDelete.reason === 'merged-pr' ||
              oldParentDelete.reason === 'merged-pr-with-trailing-commits')
          ) {
            reparentedDueToMergedParent.add(op.branch);
          }
        }
        progress.pause();
        console.log(
          `↪ Reparenting '${op.branch}' from '${op.oldParent ?? 'trunk'}' onto '${op.newParent ?? 'trunk'}'.`,
        );
        progress.resume();
        continue;
      }
      if (op.type !== 'delete') continue;
      const branch = op.branch;
      cleanupIndex += 1;
      progress.update('🧹 Cleaning merged', cleanupIndex, branch);
      if (excludedFromSync.has(branch)) continue;
      if (recordWorktreeSkip(branch)) continue;
      const descendants = reparentedFromBranch.get(branch) ?? [];
      progress.pause();
      if (descendants.length > 0) {
        console.log(
          `⚠ Auto-clean deleting '${branch}' (${op.reason}) with dependent branch(es): ${descendants.join(', ')}. Their parent will be reassigned in local DubStack state.`,
        );
      } else {
        console.log(`• Auto-clean deleting '${branch}' (${op.reason}).`);
      }
      if (op.reason === 'merged-pr-with-trailing-commits') {
        const trailingOutcome: BranchSyncOutcome = {
          branch,
          status: 'squash-merged-with-trailing-commits',
          action: 'deleted',
          message: `⚠ '${branch}' was squash-merged but had trailing local commits. Recover them via 'git reflog' and re-track with 'dub track <new-branch> --parent <branch>'.`,
          reconcileSource: 'sync-squash-merged-cleanup',
        };
        result.branches.push(trailingOutcome);
        printBranchOutcome(trailingOutcome);
        recordSource(result.reconcileSources, 'sync-squash-merged-cleanup');
      }
      progress.resume();
      await appendCleanupOperation(cwd, cleanupJournal, op);
      const fallbackTarget = roots[0] ?? originalBranch;
      await checkoutBranch(fallbackTarget, cwd);
      await appendCheckoutHistory(cwd, fallbackTarget, {
        via: 'sync',
        transient: true,
      });
      await deleteBranch(branch, cwd);
      // Reparenting was already journaled+applied via explicit reparent ops;
      // here we just drop the entry from state.
      dropBranchFromState(scopeStacks, branch);
      result.cleaned.push(branch);
    }
    await clearCleanupJournal(cwd);
    if (cleanupPlan.toDelete.length > 0) {
      progress.complete('🧹 Cleaning merged');
    }
    for (const skipped of cleanupPlan.skipped) {
      console.log(
        `• Skipped cleanup for '${skipped.branch}' (${skipped.reason}).`,
      );
    }
    for (const excluded of excludedFromSync) {
      console.log(
        `• Excluding '${excluded}' from sync because its stack is not cleanable yet.`,
      );
    }

    console.log('🔄 Syncing branches...');
    if (stackBranches.length > 0) {
      progress.start('🔄 Reconciling', stackBranches.length);
    }
    let reconcileIndex = 0;
    for (const branch of stackBranches) {
      reconcileIndex += 1;
      progress.update('🔄 Reconciling', reconcileIndex, branch);
      if (result.cleaned.includes(branch) || excludedFromSync.has(branch))
        continue;
      if (recordWorktreeSkip(branch)) continue;

      if (frozenBranches.has(branch)) {
        const outcome: BranchSyncOutcome = {
          branch,
          status: 'frozen-skipped',
          action: 'skipped',
          message: `🔒 Skipped '${branch}' (frozen). Run \`dub unfreeze ${branch}\` to allow sync reconciliation.`,
          reconcileSource: 'sync-skip',
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        recordSource(result.reconcileSources, 'sync-skip');
        continue;
      }

      if (freshSkipped.has(branch)) {
        // `pruneRemote` ran just above, so a branch deleted upstream since
        // the last sync may have lost its `origin/<branch>` ref. Fall through
        // to the normal classification path in that case so the user sees
        // `missing-remote` instead of a misleading "reused cached state".
        const remoteStillExists = await remoteBranchExists(branch, cwd);
        if (remoteStillExists) {
          const outcome: BranchSyncOutcome = {
            branch,
            status: 'fresh',
            action: 'cached',
            message: `⚡ '${branch}' synced recently — reused cached state (--fresh to refetch).`,
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          continue;
        }
      }

      try {
        if (reparentedDueToMergedParent.has(branch)) {
          const newParent = stateBranchMap.get(branch)?.parent ?? null;
          const orphanOutcome: BranchSyncOutcome = {
            branch,
            status: 'parent-merged-orphan',
            action: 'synced',
            message: `↪ Reparented '${branch}' onto '${newParent ?? 'trunk'}' (parent PR merged).`,
            reconcileSource: 'sync-parent-merged-reparent',
          };
          result.branches.push(orphanOutcome);
          printBranchOutcome(orphanOutcome);
          recordSource(result.reconcileSources, 'sync-parent-merged-reparent');
          continue;
        }

        const hasRemote = await remoteBranchExists(branch, cwd);
        const hasLocal = await branchExists(branch, cwd);
        let outcome: BranchSyncOutcome;

        const remoteRef = `origin/${branch}`;
        const localSha = hasLocal ? await getRefSha(branch, cwd) : null;
        const remoteSha = hasRemote ? await getRefSha(remoteRef, cwd) : null;
        const localBehind =
          hasLocal && hasRemote
            ? await isAncestor(branch, remoteRef, cwd)
            : false;
        const remoteBehind =
          hasLocal && hasRemote
            ? await isAncestor(remoteRef, branch, cwd)
            : false;
        const prSyncInfo = hasRemote
          ? await lookupPrSyncInfo(branch)
          : { state: 'NONE' as const, baseRefName: null };
        const localParent = stateBranchMap.get(branch)?.parent ?? null;
        const remoteParentDiffers =
          hasRemote &&
          hasLocal &&
          prSyncInfo.baseRefName != null &&
          localParent != null &&
          prSyncInfo.baseRefName !== localParent;
        const remoteContainsNewParentHistory =
          remoteParentDiffers && prSyncInfo.baseRefName
            ? await isAncestor(
                `origin/${prSyncInfo.baseRefName}`,
                remoteRef,
                cwd,
              ).catch(() => false)
            : false;

        let status = classifyBranchSyncStatus({
          hasRemote,
          hasLocal,
          localSha,
          remoteSha,
          localBehind,
          remoteBehind,
          hasSubmittedBaseline:
            stateBranchMap.get(branch)?.last_submitted_version != null,
          remoteBaseRefName: prSyncInfo.baseRefName,
          localParent,
          remoteContainsNewParentHistory,
        });
        // Refinement: when local is behind remote, prefer the safe FF path even
        // when the PR's remote base differs — auto-FF + parent adopt handles
        // both. Only escalate to needs-remote-sync when local has unrelated work.
        if (
          status !== 'remote-restacked' &&
          hasRemote &&
          hasLocal &&
          localSha !== remoteSha &&
          status !== 'local-ahead' &&
          status !== 'needs-remote-sync-safe' &&
          remoteParentDiffers
        ) {
          status = 'needs-remote-sync';
        }

        if (status === 'missing-remote') {
          outcome = {
            branch,
            status,
            action: 'skipped',
            message: `⚠ Skipped '${branch}' (missing on remote).`,
            reconcileSource: 'sync-skip',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          recordSource(result.reconcileSources, 'sync-skip');
          continue;
        }

        if (status === 'missing-local') {
          await checkoutRemoteBranch(branch, cwd);
          outcome = {
            branch,
            status,
            action: 'synced',
            message: `✔ Restored '${branch}' from remote.`,
            reconcileSource: 'sync-adopt-remote-safe',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          const restoredSha = await getRefSha(branch, cwd);
          await markBranchSynced(stateBranchMap, branch, restoredSha, cwd, {
            source: 'sync-adopt-remote-safe',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          });
          recordSource(result.reconcileSources, 'sync-adopt-remote-safe');
          continue;
        }

        if (status === 'up-to-date') {
          outcome = {
            branch,
            status,
            action: 'none',
            message: `• '${branch}' is up to date.`,
            reconcileSource: 'sync-no-change',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          await markBranchSynced(
            stateBranchMap,
            branch,
            localSha ?? remoteSha ?? null,
            cwd,
            {
              source: 'sync-no-change',
              baseBranch: stateBranchMap.get(branch)?.parent ?? null,
            },
          );
          recordSource(result.reconcileSources, 'sync-no-change');
          continue;
        }

        if (status === 'updated-outside-dubstack-but-up-to-date') {
          outcome = {
            branch,
            status,
            action: 'none',
            message: `• '${branch}' is up to date but was previously unmanaged by DubStack sync metadata.`,
            reconcileSource: 'sync-no-change',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          await markBranchSynced(
            stateBranchMap,
            branch,
            localSha ?? remoteSha ?? null,
            cwd,
            {
              source: 'sync-no-change',
              baseBranch: stateBranchMap.get(branch)?.parent ?? null,
            },
          );
          recordSource(result.reconcileSources, 'sync-no-change');
          continue;
        }

        if (status === 'needs-remote-sync-safe') {
          // Refinement: when local is a strict subset of remote and the PR
          // base also moved, adopt the remote parent silently as part of FF.
          const adoptingParent =
            remoteParentDiffers && prSyncInfo.baseRefName != null;
          if (adoptingParent) {
            console.log(
              `↪ Adopting remote parent '${prSyncInfo.baseRefName}' for '${branch}' (PR base differs from local).`,
            );
          }
          await hardResetBranchToRef(branch, remoteRef, cwd);
          if (adoptingParent && prSyncInfo.baseRefName) {
            const stateBranch = stateBranchMap.get(branch);
            if (stateBranch) stateBranch.parent = prSyncInfo.baseRefName;
          }
          const adoptedSource: ReconcileSource = adoptingParent
            ? 'sync-adopt-remote-parent'
            : 'sync-adopt-remote-safe';
          outcome = {
            branch,
            status,
            action: 'synced',
            message: adoptingParent
              ? `✔ Synced '${branch}' to remote head and adopted remote parent '${prSyncInfo.baseRefName ?? 'unknown'}'.`
              : `✔ Synced '${branch}' to remote head.`,
            reconcileSource: adoptedSource,
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
            source: adoptedSource,
            baseBranch: adoptingParent
              ? (prSyncInfo.baseRefName ?? localParent)
              : (stateBranchMap.get(branch)?.parent ?? null),
          });
          recordSource(result.reconcileSources, adoptedSource);
          continue;
        }

        if (status === 'local-ahead') {
          outcome = {
            branch,
            status,
            action: 'kept-local',
            message: `• Kept local '${branch}' (local commits ahead of remote).`,
            reconcileSource: 'sync-keep-local',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          await markBranchSynced(stateBranchMap, branch, localSha, cwd, {
            source: 'sync-no-change',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          });
          recordSource(result.reconcileSources, 'sync-keep-local');
          continue;
        }

        if (status === 'remote-restacked') {
          await hardResetBranchToRef(branch, remoteRef, cwd);
          if (prSyncInfo.baseRefName) {
            const stateBranch = stateBranchMap.get(branch);
            if (stateBranch) stateBranch.parent = prSyncInfo.baseRefName;
          }
          outcome = {
            branch,
            status,
            action: 'synced',
            message: `✔ '${branch}' was remote-restacked onto '${prSyncInfo.baseRefName ?? 'new parent'}'; adopted remote.`,
            reconcileSource: 'sync-remote-restacked',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
            source: 'sync-remote-restacked',
            baseBranch: prSyncInfo.baseRefName ?? localParent,
          });
          recordSource(result.reconcileSources, 'sync-remote-restacked');
          continue;
        }

        if (status === 'unsubmitted') {
          if (options.force) {
            await hardResetBranchToRef(branch, remoteRef, cwd);
            outcome = {
              branch,
              status,
              action: 'synced',
              message: `✔ Synced unsubmitted branch '${branch}' to remote with --force.`,
              reconcileSource: 'sync-force',
            };
            await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
              source: 'sync-force',
              baseBranch: localParent,
            });
            recordSource(result.reconcileSources, 'sync-force');
          } else if (!options.interactive) {
            outcome = {
              branch,
              status,
              action: 'skipped',
              message: `⚠ Skipped unsubmitted branch '${branch}' (use --force or interactive mode).`,
              reconcileSource: 'sync-skip',
            };
            recordSource(result.reconcileSources, 'sync-skip');
          } else {
            const unsubmittedDecision = await resolveUnsubmittedDecision({
              cwd,
              branch,
              remoteRef,
              localParent,
              showAiPromptOptions,
            });
            if (unsubmittedDecision === 'remote') {
              await hardResetBranchToRef(branch, remoteRef, cwd);
              outcome = {
                branch,
                status,
                action: 'synced',
                message: `✔ Synced unsubmitted branch '${branch}' to remote.`,
                reconcileSource: 'sync-adopt-remote-safe',
              };
              await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
                source: 'sync-adopt-remote-safe',
                baseBranch: localParent,
              });
              recordSource(result.reconcileSources, 'sync-adopt-remote-safe');
            } else if (unsubmittedDecision === 'local') {
              outcome = {
                branch,
                status,
                action: 'kept-local',
                message: `• Kept local unsubmitted branch '${branch}'.`,
                reconcileSource: 'sync-keep-local',
              };
              recordSource(result.reconcileSources, 'sync-keep-local');
            } else {
              outcome = {
                branch,
                status,
                action: 'skipped',
                message: `⚠ Skipped unsubmitted branch '${branch}' by user choice.`,
                reconcileSource: 'sync-skip',
              };
              recordSource(result.reconcileSources, 'sync-skip');
            }
          }
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          continue;
        }

        if (status === 'needs-remote-sync') {
          if (options.force) {
            await hardResetBranchToRef(branch, remoteRef, cwd);
            if (
              prSyncInfo.baseRefName &&
              localParent !== prSyncInfo.baseRefName
            ) {
              const stateBranch = stateBranchMap.get(branch);
              if (stateBranch) stateBranch.parent = prSyncInfo.baseRefName;
            }
            outcome = {
              branch,
              status,
              action: 'synced',
              message: `✔ Synced '${branch}' to remote and adopted remote parent '${prSyncInfo.baseRefName ?? 'unknown'}'.`,
              reconcileSource: 'sync-adopt-remote-parent',
            };
            await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
              source: 'sync-adopt-remote-parent',
              baseBranch: prSyncInfo.baseRefName ?? localParent,
            });
            recordSource(result.reconcileSources, 'sync-adopt-remote-parent');
          } else if (!options.interactive) {
            outcome = {
              branch,
              status,
              action: 'skipped',
              message: `⚠ Skipped '${branch}' parent-mismatch sync (run interactively or with --force).`,
              reconcileSource: 'sync-skip',
            };
            recordSource(result.reconcileSources, 'sync-skip');
          } else {
            const parentDecision = await resolveParentMismatchDecision({
              cwd,
              branch,
              remoteRef,
              localParent,
              remoteParent: prSyncInfo.baseRefName,
              showAiPromptOptions,
            });
            if (parentDecision === 'remote') {
              await hardResetBranchToRef(branch, remoteRef, cwd);
              const stateBranch = stateBranchMap.get(branch);
              if (stateBranch && prSyncInfo.baseRefName) {
                stateBranch.parent = prSyncInfo.baseRefName;
              }
              outcome = {
                branch,
                status,
                action: 'synced',
                message: `✔ Synced '${branch}' to remote and adopted remote parent.`,
                reconcileSource: 'sync-adopt-remote-parent',
              };
              await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
                source: 'sync-adopt-remote-parent',
                baseBranch: prSyncInfo.baseRefName ?? localParent,
              });
              recordSource(result.reconcileSources, 'sync-adopt-remote-parent');
            } else if (parentDecision === 'local') {
              outcome = {
                branch,
                status,
                action: 'kept-local',
                message: `• Kept local parent and local state for '${branch}'.`,
                reconcileSource: 'sync-keep-local',
              };
              recordSource(result.reconcileSources, 'sync-keep-local');
            } else {
              outcome = {
                branch,
                status,
                action: 'skipped',
                message: `⚠ Skipped '${branch}' parent-mismatch sync by user choice.`,
                reconcileSource: 'sync-skip',
              };
              recordSource(result.reconcileSources, 'sync-skip');
            }
          }
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          continue;
        }

        // reconcile-needed: attempt a clean rebase first; if that succeeds we
        // treat the branch as `non-conflicting-divergence` automatically. The
        // trial is destructive on success — log it so the user sees the change.
        console.log(
          `↻ Trying clean rebase of '${branch}' onto '${remoteRef}'…`,
        );
        const reconciledClean = await rebaseBranchOntoRef(
          branch,
          remoteRef,
          cwd,
        );
        if (reconciledClean) {
          const newSha = await getRefSha(branch, cwd);
          outcome = {
            branch,
            status: 'non-conflicting-divergence',
            action: 'synced',
            message: `✔ Auto-rebased '${branch}' onto remote (non-conflicting divergence).`,
            reconcileSource: 'sync-rebase-onto-remote',
          };
          result.branches.push(outcome);
          printBranchOutcome(outcome);
          await markBranchSynced(stateBranchMap, branch, newSha, cwd, {
            source: 'sync-rebase-onto-remote',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          });
          recordSource(result.reconcileSources, 'sync-rebase-onto-remote');
          continue;
        }

        let decision = await resolveReconcileDecision({
          branch,
          force: options.force,
          interactive: options.interactive,
          promptChoice: () =>
            reconcilePrompt({ branch, showAiOption: showAiPromptOptions }),
        });

        if (decision === 'ai') {
          decision = await resolveAiPromptDecision<
            'rebase-onto-remote' | 'take-remote' | 'abort'
          >({
            cwd,
            scenario: 'three-way reconcile',
            subject: branch,
            choices: RECONCILE_AI_CHOICES,
            context: await buildBranchAiPromptContext({
              cwd,
              branch,
              remoteRef,
              localParent: stateBranchMap.get(branch)?.parent ?? null,
              status: 'reconcile-needed',
              includePrComments: true,
            }),
            fallbackPrompt: () =>
              reconcilePrompt({ branch, showAiOption: false }) as Promise<
                'rebase-onto-remote' | 'take-remote' | 'abort'
              >,
          });
        }

        if (decision === 'abort') {
          throw new SyncAbortError(branch, options.interactive);
        }

        if (decision === 'take-remote') {
          await hardResetBranchToRef(branch, remoteRef, cwd);
          outcome = {
            branch,
            status: 'reconcile-needed',
            action: 'synced',
            message: `✔ Synced '${branch}' to remote version.`,
            reconcileSource: 'sync-adopt-remote-divergent',
          };
          await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
            source: 'sync-adopt-remote-divergent',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          });
          recordSource(result.reconcileSources, 'sync-adopt-remote-divergent');
        } else {
          // decision === 'rebase-onto-remote': the user picked "Rebase your
          // changes on top of the remote version". The pre-prompt auto-rebase
          // trial above has already failed cleanly; we retry it explicitly so
          // the user sees the conflict surface, then fall back to keep-local
          // when the rebase cannot complete unattended.
          const reconciled = await rebaseBranchOntoRef(branch, remoteRef, cwd);
          outcome = {
            branch,
            status: 'reconcile-needed',
            action: reconciled ? 'synced' : 'kept-local',
            message: reconciled
              ? `✔ Reconciled '${branch}' by rebasing local commits onto remote.`
              : `⚠ Could not auto-reconcile '${branch}'. Kept local state; reconcile manually.`,
            reconcileSource: reconciled
              ? 'sync-rebase-onto-remote'
              : 'sync-keep-local',
          };
          if (reconciled) {
            const newSha = await getRefSha(branch, cwd);
            await markBranchSynced(stateBranchMap, branch, newSha, cwd, {
              source: 'sync-rebase-onto-remote',
              baseBranch: stateBranchMap.get(branch)?.parent ?? null,
            });
            recordSource(result.reconcileSources, 'sync-rebase-onto-remote');
          } else {
            recordSource(result.reconcileSources, 'sync-keep-local');
          }
        }
        result.branches.push(outcome);
        printBranchOutcome(outcome);
      } catch (branchError) {
        // A user-requested abort must halt the entire sync, not be isolated
        // as a per-branch error per DUB-13's failure-isolation contract.
        if (branchError instanceof SyncAbortError) throw branchError;
        const dubErr =
          branchError instanceof DubError
            ? branchError
            : new DubError(
                branchError instanceof Error
                  ? branchError.message
                  : 'Unexpected error during branch sync.',
                [
                  "Run 'dub doctor' to inspect stack + repo health.",
                  "Re-run 'dub sync' with --verbose to surface the underlying command.",
                ],
              );
        const errorOutcome: BranchSyncOutcome = {
          branch,
          status: 'error',
          action: 'error',
          message: dubErr.message,
          recovery: dubErr.recovery,
        };
        result.branches.push(errorOutcome);
        printBranchOutcome(errorOutcome);
      }
    }
    if (stackBranches.length > 0) {
      progress.complete('🔄 Reconciling');
    }

    state.last_sync = {
      timestamp: new Date().toISOString(),
      reconcile_sources: { ...result.reconcileSources },
    };
    await writeState(state, cwd);

    const retargeted = await retargetOpenPrBranches(scopeStacks, cwd, {
      branches: [...reparentedBranchNames],
    });
    if (retargeted.length > 0) {
      needsSubmitRefresh = true;
    }

    if (options.restack) {
      console.log('🥞 Restacking branches...');
      const rootsToRestack = options.all
        ? Array.from(
            new Set(
              scopeStacks
                .map((stack) => getStackTrunk(stack))
                .filter((root) => roots.includes(root)),
            ),
          )
        : [roots[0]].filter(Boolean);
      for (const root of rootsToRestack) {
        if (recordWorktreeSkip(root)) continue;
        await checkoutBranch(root, cwd);
        await appendCheckoutHistory(cwd, root, {
          via: 'sync',
          transient: true,
        });
        const restackResult = await restack(cwd);
        if (restackResult.status === 'conflict') {
          const conflictBranch = restackResult.conflictBranch ?? 'unknown';
          const conflictDecision = await resolveRestackConflictDecision({
            branch: conflictBranch,
            interactive: options.interactive,
            showAiOption: showAiPromptOptions,
            promptChoice: (branchName) =>
              restackConflictPrompt({
                branch: branchName,
                showAiOption: showAiPromptOptions,
              }),
          });
          if (conflictDecision === 'ai') {
            await aiResolve(cwd, {});
            restackChanged = true;
            continue;
          }
          if (conflictDecision === 'cancel') {
            const rollback = await rollbackRestack(cwd);
            console.log(
              chalk.green(
                `✔ Rolled back ${rollback.branchesRestored} branch(es) to pre-restack state.`,
              ),
            );
            restoreTarget = rollback.previousBranch;
            restackCancelled = true;
            break;
          }
          if (conflictDecision === 'exit') {
            throw new DubError(
              `Sync exited mid-conflict on '${conflictBranch}'. The restack is paused in its current state.`,
              [
                "Run 'dub continue' once you have resolved the conflict to finish the restack.",
                "Run 'dub continue --ai' to let DubStack attempt the resolution.",
                "Run 'dub abort' to cancel and roll back to the pre-restack state.",
              ],
            );
          }
          throw new DubError(
            `Sync paused: conflict while restacking '${conflictBranch}'.`,
            [
              'Resolve conflicts and stage the resolved files.',
              "Run 'dub continue --ai' to let DubStack try the resolution.",
              "Run 'dub continue' after resolving manually.",
              "Run 'dub abort' to cancel recovery and roll back progress.",
            ],
          );
        }
        if (restackResult.status === 'success') {
          restackChanged = true;
        }
      }
      result.restacked = !restackCancelled;
    }

    if (
      !restackCancelled &&
      (result.cleaned.length > 0 || needsSubmitRefresh || restackChanged)
    ) {
      const preferredBranch = resolvePreferredBranch(
        scopeStacks,
        originalBranch,
        scopeStacks,
      );
      restoreTarget = preferredBranch ?? originalBranch;
      if (needsSubmitRefresh && scopeStacks.some(hasNonRootBranches)) {
        if (preferredBranch) {
          await checkoutBranch(preferredBranch, cwd);
          await appendCheckoutHistory(cwd, preferredBranch, {
            via: 'sync',
            transient: true,
          });
        }
        await submitRefreshedStacks(cwd, scopeStacks, {
          all: options.all,
        });
      }
    }
  } catch (error) {
    pendingError = await wrapSyncError(error, cwd);
  } finally {
    progress.stop();
  }

  const activeOperation = await detectActiveOperation(cwd).catch(() => 'none');
  if (activeOperation === 'none') {
    try {
      await checkoutBranch(restoreTarget, cwd);
      await appendCheckoutHistory(cwd, restoreTarget, {
        via: 'sync',
        transient: true,
      });
    } catch {
      if (!pendingError) {
        pendingError = new DubError(
          `Sync completed but could not restore branch '${restoreTarget}'.`,
          [
            `Run 'git checkout ${restoreTarget}' to return to your working context.`,
            'Inspect the working tree for uncommitted changes that may be blocking checkout.',
          ],
        );
      }
    }
  }
  if (pendingError) {
    throw pendingError;
  }
  printSyncSummary(result);
  const erroredBranches = result.branches.filter((b) => b.action === 'error');
  if (erroredBranches.length > 0) {
    const branchList = erroredBranches.map((b) => b.branch).join(', ');
    const detailLines = erroredBranches.map(
      (b) => `- ${b.branch}: ${b.message}`,
    );
    throw new DubError(
      `Sync completed with errors on ${erroredBranches.length} branch(es): ${branchList}.\n${detailLines.join('\n')}`,
      [
        'Review the per-branch error messages above for root cause and recovery steps.',
        "Re-run 'dub sync' after resolving the underlying issues.",
      ],
    );
  }
  return result;
}

async function wrapSyncError(error: unknown, cwd: string): Promise<Error> {
  const baseError =
    error instanceof DubError
      ? error
      : new DubError(
          error instanceof Error ? error.message : 'Sync failed unexpectedly.',
          [
            "Run 'dub doctor' to inspect stack + repo health.",
            "Re-run 'dub sync' with --verbose to surface the underlying command.",
          ],
        );
  const activeOperation = await detectActiveOperation(cwd).catch(() => 'none');
  if (activeOperation === 'none') {
    return baseError;
  }
  const recovery =
    baseError.recovery.length > 0
      ? baseError.recovery
      : [
          "Run 'dub continue --ai' to let DubStack try the resolution.",
          "Run 'dub continue' after resolving conflicts manually.",
          "Run 'dub abort' to exit the in-progress operation safely.",
        ];
  return new DubError(baseError.message, recovery);
}

const ADOPT_REMOTE_SOURCES: ReadonlySet<ReconcileSource> = new Set([
  'sync-adopt-remote-safe',
  'sync-adopt-remote-divergent',
  'sync-adopt-remote-parent',
  'sync-remote-restacked',
  'sync-parent-merged-reparent',
  'sync-force',
]);

function isAdoptRemoteSource(source: ReconcileSource): boolean {
  return ADOPT_REMOTE_SOURCES.has(source);
}

function isNoChangeSource(source: ReconcileSource): boolean {
  return source === 'sync-no-change';
}

function recordSource(
  histogram: ReconcileSourceHistogram,
  source: ReconcileSource,
): void {
  histogram[source] = (histogram[source] ?? 0) + 1;
}

async function markBranchSynced(
  branchMap: Map<string, Branch>,
  branchName: string,
  headSha: string | null,
  cwd: string,
  options: {
    source: ReconcileSource;
    baseBranch: string | null;
  },
): Promise<void> {
  if (!headSha) return;
  const entry = branchMap.get(branchName);
  if (!entry) return;
  const priorBaseline = entry.last_submitted_version;
  const isAdoptingRemote = isAdoptRemoteSource(options.source);
  const isNoChange = isNoChangeSource(options.source);
  const resolvedBaseBranch =
    options.baseBranch ?? priorBaseline?.base_branch ?? null;
  const canPreservePriorBaseSha =
    isAdoptingRemote &&
    resolvedBaseBranch != null &&
    priorBaseline?.base_branch === resolvedBaseBranch &&
    priorBaseline.base_sha != null;
  let resolvedBaseSha = canPreservePriorBaseSha
    ? (priorBaseline?.base_sha ?? null)
    : null;
  if (resolvedBaseBranch) {
    if (!resolvedBaseSha) {
      try {
        resolvedBaseSha = await getRefSha(resolvedBaseBranch, cwd);
      } catch {
        // Keep existing baseline SHA if base ref isn't currently resolvable.
      }
    }
  }
  if (!resolvedBaseBranch || !resolvedBaseSha) {
    if (isAdoptingRemote) {
      entry.parent_revision = null;
    }
    // Stamp the sync timestamp even when baseline metadata can't be
    // resolved — the branch was still processed by sync, and the freshness
    // cache must reflect that so the next run can skip its fetch.
    entry.last_synced_at = new Date().toISOString();
    return;
  }
  const preservedSource: ReconcileSource =
    priorBaseline?.source ?? entry.sync_source ?? 'imported';
  entry.last_submitted_version = {
    head_sha: headSha,
    base_sha: resolvedBaseSha,
    base_branch: resolvedBaseBranch,
    version_number: priorBaseline?.version_number ?? null,
    source: isNoChange ? preservedSource : options.source,
  };
  entry.last_reconciled_version = {
    head_sha: headSha,
    base_sha: resolvedBaseSha,
    base_branch: resolvedBaseBranch,
    source: options.source,
  };
  if (isAdoptingRemote) {
    if (canPreservePriorBaseSha) {
      entry.parent_revision = resolvedBaseSha;
    } else {
      try {
        entry.parent_revision = (await isAncestor(
          resolvedBaseSha,
          headSha,
          cwd,
        ))
          ? resolvedBaseSha
          : null;
      } catch {
        entry.parent_revision = null;
      }
    }
  } else {
    try {
      if (await isAncestor(resolvedBaseSha, headSha, cwd)) {
        entry.parent_revision = resolvedBaseSha;
      }
    } catch {
      // If ancestry check fails, keep existing parent_revision.
    }
  }
  entry.last_synced_at = new Date().toISOString();
  entry.sync_source = isNoChange ? preservedSource : options.source;
}

function getDescendants(stacks: Array<{ branches: Branch[] }>, branch: string) {
  const descendants: string[] = [];
  const childMap = new Map<string, string[]>();
  for (const stack of stacks) {
    for (const node of stack.branches) {
      if (!node.parent) continue;
      const children = childMap.get(node.parent) ?? [];
      children.push(node.name);
      childMap.set(node.parent, children);
    }
  }
  const queue = [...(childMap.get(branch) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    descendants.push(next);
    queue.push(...(childMap.get(next) ?? []));
  }
  return descendants;
}

function dropBranchFromState(
  stacks: Array<{ branches: Branch[] }>,
  branch: string,
): void {
  for (const stack of stacks) {
    stack.branches = stack.branches.filter((b) => b.name !== branch);
  }
}
