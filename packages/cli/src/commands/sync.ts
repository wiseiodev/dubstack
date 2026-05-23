import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  checkoutRemoteBranch,
  clearStaleNamespacedFetchRefs,
  deleteBranch,
  fastForwardBranchToRef,
  fetchBranches,
  formatWorktreeCheckoutSkipMessage,
  getCurrentBranch,
  getRefSha,
  hardResetBranchToRef,
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
import {
  resolveRestackConflictDecision,
  restackConflictPrompt,
} from '../lib/restack-conflict-prompt';
import { rollbackRestack } from '../lib/restack-rollback';
import {
  type Branch,
  findStackForBranch,
  readState,
  writeState,
} from '../lib/state';
import { classifyBranchSyncStatus } from '../lib/sync/branch-status';
import { buildCleanupPlan } from '../lib/sync/cleanup';
import { resolveReconcileDecision } from '../lib/sync/reconcile';
import { reconcilePrompt } from '../lib/sync/reconcile-prompt';
import { printBranchOutcome, printSyncSummary } from '../lib/sync/report';
import type {
  BranchSyncOutcome,
  SyncOptions,
  SyncResult,
} from '../lib/sync/types';
import { restack } from './restack';
import {
  hasNonRootBranches,
  resolvePreferredBranch,
  retargetOpenPrBranches,
  submitRefreshedStacks,
} from './stack-maintenance';

function isInteractiveShell(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [Y/n] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

async function choose(
  question: string,
  choices: Array<{ label: string; value: string }>,
): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(question);
    for (let i = 0; i < choices.length; i++) {
      console.log(`  ${i + 1}. ${choices[i].label}`);
    }
    const answer = await rl.question('Select option: ');
    const idx = Number.parseInt(answer.trim(), 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= choices.length) {
      return choices[choices.length - 1].value;
    }
    return choices[idx].value;
  } finally {
    rl.close();
  }
}

export async function sync(
  cwd: string,
  rawOptions: {
    restack?: boolean;
    force?: boolean;
    all?: boolean;
    interactive?: boolean;
  } = {},
): Promise<SyncResult> {
  await ensureGhInstalled();
  await checkGhAuth();

  const options: SyncOptions = {
    restack: rawOptions.restack ?? true,
    force: rawOptions.force ?? false,
    all: rawOptions.all ?? false,
    interactive: rawOptions.interactive ?? isInteractiveShell(),
  };

  const state = await readState(cwd);
  const originalBranch = await getCurrentBranch(cwd);
  const worktreeCheckouts = await listWorktreeCheckouts(cwd);

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

  const roots = Array.from(
    new Set(
      scopeStacks
        .flatMap((s) => s.branches)
        .filter((b) => b.type === 'root')
        .map((b) => b.name),
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
  };
  const rootHasRemote = new Map<string, boolean>();
  let pendingError: Error | null = null;
  let restoreTarget = originalBranch;
  let needsSubmitRefresh = false;
  let restackChanged = false;
  let restackCancelled = false;
  const reparentedBranchNames = new Set<string>();
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

    console.log('🌲 Fetching branches from remote...');
    const toFetch = [...new Set([...roots, ...stackBranches])];
    if (toFetch.length > 0) {
      await fetchBranches(toFetch, cwd);
      result.fetched = toFetch;
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
    const cleanupPlan = await buildCleanupPlan({
      branches: localTrackedBranches,
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
    for (const entry of cleanupPlan.toDelete) {
      const branch = entry.branch;
      if (excludedFromSync.has(branch)) continue;
      if (recordWorktreeSkip(branch)) continue;
      const descendants = getDescendants(scopeStacks, branch).filter(
        (name) =>
          !cleanupPlan.toDelete.some((target) => target.branch === name),
      );
      if (descendants.length > 0) {
        console.log(
          `⚠ Auto-clean deleting '${branch}' (${entry.reason}) with dependent branch(es): ${descendants.join(', ')}. Their parent will be reassigned in local DubStack state.`,
        );
      } else {
        console.log(`• Auto-clean deleting '${branch}' (${entry.reason}).`);
      }
      await checkoutBranch(roots[0] ?? originalBranch, cwd);
      await deleteBranch(branch, cwd);
      for (const entry of removeBranchFromState(scopeStacks, branch)) {
        reparentedBranchNames.add(entry.branch);
      }
      result.cleaned.push(branch);
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
    for (const branch of stackBranches) {
      if (result.cleaned.includes(branch) || excludedFromSync.has(branch))
        continue;
      if (recordWorktreeSkip(branch)) continue;

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
      let status = classifyBranchSyncStatus({
        hasRemote,
        hasLocal,
        localSha,
        remoteSha,
        localBehind,
        remoteBehind,
        hasSubmittedBaseline:
          stateBranchMap.get(branch)?.last_submitted_version != null,
      });
      const prSyncInfo = hasRemote
        ? await lookupPrSyncInfo(branch)
        : { state: 'NONE' as const, baseRefName: null };
      const localParent = stateBranchMap.get(branch)?.parent ?? null;
      if (
        hasRemote &&
        hasLocal &&
        localSha !== remoteSha &&
        status !== 'local-ahead' &&
        prSyncInfo.baseRefName &&
        localParent &&
        prSyncInfo.baseRefName !== localParent
      ) {
        status = 'needs-remote-sync';
      }

      if (status === 'missing-remote') {
        outcome = {
          branch,
          status,
          action: 'skipped',
          message: `⚠ Skipped '${branch}' (missing on remote).`,
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        continue;
      }

      if (status === 'missing-local') {
        await checkoutRemoteBranch(branch, cwd);
        outcome = {
          branch,
          status,
          action: 'synced',
          message: `✔ Restored '${branch}' from remote.`,
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        const restoredSha = await getRefSha(branch, cwd);
        await markBranchSynced(stateBranchMap, branch, restoredSha, cwd, {
          source: 'sync-adopt-remote',
          baseBranch: stateBranchMap.get(branch)?.parent ?? null,
        });
        continue;
      }

      if (status === 'up-to-date') {
        outcome = {
          branch,
          status,
          action: 'none',
          message: `• '${branch}' is up to date.`,
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        await markBranchSynced(
          stateBranchMap,
          branch,
          localSha ?? remoteSha ?? null,
          cwd,
          {
            source: 'sync-noop',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          },
        );
        continue;
      }

      if (status === 'updated-outside-dubstack-but-up-to-date') {
        outcome = {
          branch,
          status,
          action: 'none',
          message: `• '${branch}' is up to date but was previously unmanaged by DubStack sync metadata.`,
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        await markBranchSynced(
          stateBranchMap,
          branch,
          localSha ?? remoteSha ?? null,
          cwd,
          {
            source: 'sync-noop',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          },
        );
        continue;
      }

      if (status === 'needs-remote-sync-safe') {
        await hardResetBranchToRef(branch, remoteRef, cwd);
        outcome = {
          branch,
          status,
          action: 'synced',
          message: `✔ Synced '${branch}' to remote head.`,
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
          source: 'sync-adopt-remote',
          baseBranch: stateBranchMap.get(branch)?.parent ?? null,
        });
        continue;
      }

      if (status === 'local-ahead') {
        outcome = {
          branch,
          status,
          action: 'kept-local',
          message: `• Kept local '${branch}' (local commits ahead of remote).`,
        };
        result.branches.push(outcome);
        printBranchOutcome(outcome);
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
          };
          await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
            source: 'sync-adopt-remote',
            baseBranch: localParent,
          });
        } else if (!options.interactive) {
          outcome = {
            branch,
            status,
            action: 'skipped',
            message: `⚠ Skipped unsubmitted branch '${branch}' (use --force or interactive mode).`,
          };
        } else {
          const takeRemote = await confirm(
            `Branch '${branch}' has no DubStack submit baseline. Overwrite local with remote version?`,
          );
          if (takeRemote) {
            await hardResetBranchToRef(branch, remoteRef, cwd);
            outcome = {
              branch,
              status,
              action: 'synced',
              message: `✔ Synced unsubmitted branch '${branch}' to remote.`,
            };
            await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
              source: 'sync-adopt-remote',
              baseBranch: localParent,
            });
          } else {
            outcome = {
              branch,
              status,
              action: 'kept-local',
              message: `• Kept local unsubmitted branch '${branch}'.`,
            };
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
          };
          await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
            source: 'sync-adopt-remote',
            baseBranch: prSyncInfo.baseRefName ?? localParent,
          });
        } else if (!options.interactive) {
          outcome = {
            branch,
            status,
            action: 'skipped',
            message: `⚠ Skipped '${branch}' parent-mismatch sync (run interactively or with --force).`,
          };
        } else {
          const parentDecision = await choose(
            `Branch '${branch}' parent differs locally ('${localParent}') vs remote ('${prSyncInfo.baseRefName}').`,
            [
              {
                label: 'Take remote version and remote parent',
                value: 'remote',
              },
              { label: 'Keep local branch and parent', value: 'local' },
              { label: 'Skip for now', value: 'skip' },
            ],
          );
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
            };
            await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
              source: 'sync-adopt-remote',
              baseBranch: prSyncInfo.baseRefName ?? localParent,
            });
          } else if (parentDecision === 'local') {
            outcome = {
              branch,
              status,
              action: 'kept-local',
              message: `• Kept local parent and local state for '${branch}'.`,
            };
          } else {
            outcome = {
              branch,
              status,
              action: 'skipped',
              message: `⚠ Skipped '${branch}' parent-mismatch sync by user choice.`,
            };
          }
        }
        result.branches.push(outcome);
        printBranchOutcome(outcome);
        continue;
      }

      const decision = await resolveReconcileDecision({
        branch,
        force: options.force,
        interactive: options.interactive,
        promptChoice: () => reconcilePrompt({ branch }),
      });

      if (decision === 'abort') {
        throw new DubError(
          `Sync aborted by user while reconciling '${branch}'.`,
          [
            "Run 'dub sync' again to retry the reconcile flow.",
            "Pass '--force --no-interactive' to take the remote version without prompting.",
            "Pass '--force' alone if you want the prompt but a fallback take-remote on --no-interactive shells.",
          ],
        );
      }

      if (decision === 'take-remote') {
        await hardResetBranchToRef(branch, remoteRef, cwd);
        outcome = {
          branch,
          status: 'reconcile-needed',
          action: 'synced',
          message: `✔ Synced '${branch}' to remote version.`,
        };
        await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
          source: 'sync-adopt-remote',
          baseBranch: stateBranchMap.get(branch)?.parent ?? null,
        });
      } else {
        const reconciled = await rebaseBranchOntoRef(branch, remoteRef, cwd);
        outcome = {
          branch,
          status: 'reconcile-needed',
          action: reconciled ? 'synced' : 'kept-local',
          message: reconciled
            ? `✔ Reconciled '${branch}' by rebasing local commits onto remote.`
            : `⚠ Could not auto-reconcile '${branch}'. Kept local state; reconcile manually.`,
        };
        if (reconciled) {
          const newSha = await getRefSha(branch, cwd);
          await markBranchSynced(stateBranchMap, branch, newSha, cwd, {
            source: 'sync-restack',
            baseBranch: stateBranchMap.get(branch)?.parent ?? null,
          });
        }
      }
      result.branches.push(outcome);
      printBranchOutcome(outcome);
    }

    await writeState(state, cwd);

    const retargeted = await retargetOpenPrBranches(scopeStacks, cwd, {
      branches: [...reparentedBranchNames],
    });
    if (retargeted.length > 0) {
      needsSubmitRefresh = true;
    }

    if (options.restack) {
      console.log('🥞 Restacking branches...');
      const rootsToRestack = options.all ? roots : [roots[0]].filter(Boolean);
      for (const root of rootsToRestack) {
        if (recordWorktreeSkip(root)) continue;
        await checkoutBranch(root, cwd);
        const restackResult = await restack(cwd);
        if (restackResult.status === 'conflict') {
          const conflictBranch = restackResult.conflictBranch ?? 'unknown';
          const conflictDecision = await resolveRestackConflictDecision({
            branch: conflictBranch,
            interactive: options.interactive,
            promptChoice: (branchName) =>
              restackConflictPrompt({ branch: branchName }),
          });
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
        }
        await submitRefreshedStacks(cwd, scopeStacks, {
          all: options.all,
        });
      }
    }
  } catch (error) {
    pendingError = await wrapSyncError(error, cwd);
  }

  const activeOperation = await detectActiveOperation(cwd).catch(() => 'none');
  if (activeOperation === 'none') {
    try {
      await checkoutBranch(restoreTarget, cwd);
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
  return result;
}

async function wrapSyncError(error: unknown, cwd: string): Promise<Error> {
  const baseError =
    error instanceof DubError
      ? error
      : new DubError(
          error instanceof Error ? error.message : 'Sync failed unexpectedly.',
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

async function markBranchSynced(
  branchMap: Map<string, Branch>,
  branchName: string,
  headSha: string | null,
  cwd: string,
  options: {
    source: 'sync-adopt-remote' | 'sync-noop' | 'sync-restack';
    baseBranch: string | null;
  },
): Promise<void> {
  if (!headSha) return;
  const entry = branchMap.get(branchName);
  if (!entry) return;
  const priorBaseline = entry.last_submitted_version;
  const isAdoptingRemote = options.source === 'sync-adopt-remote';
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
    return;
  }
  const preservedSource =
    priorBaseline?.source ?? entry.sync_source ?? 'imported';
  entry.last_submitted_version = {
    head_sha: headSha,
    base_sha: resolvedBaseSha,
    base_branch: resolvedBaseBranch,
    version_number: priorBaseline?.version_number ?? null,
    source: options.source === 'sync-noop' ? preservedSource : 'sync',
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
  entry.sync_source = options.source === 'sync-noop' ? preservedSource : 'sync';
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

function removeBranchFromState(
  stacks: Array<{ branches: Branch[] }>,
  branch: string,
) {
  const reparented: Array<{ branch: string; parent: string | null }> = [];
  for (const stack of stacks) {
    const deleted = stack.branches.find((b) => b.name === branch);
    if (!deleted) continue;
    const newParent = deleted.parent;
    for (const child of stack.branches) {
      if (child.parent === branch) {
        child.parent = newParent;
        reparented.push({ branch: child.name, parent: child.parent });
      }
    }
    stack.branches = stack.branches.filter((b) => b.name !== branch);
  }
  return reparented;
}
