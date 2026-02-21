import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { DubError } from "../lib/errors";
import {
	branchExists,
	checkoutBranch,
	checkoutRemoteBranch,
	deleteBranch,
	fastForwardBranchToRef,
	fetchBranches,
	getCurrentBranch,
	getRefSha,
	hardResetBranchToRef,
	isAncestor,
	rebaseBranchOntoRef,
	remoteBranchExists,
} from "../lib/git";
import {
	checkGhAuth,
	ensureGhInstalled,
	getBranchPrLifecycleState,
	getBranchPrSyncInfo,
} from "../lib/github";
import { detectActiveOperation } from "../lib/operation-state";
import {
	type Branch,
	findStackForBranch,
	readState,
	writeState,
} from "../lib/state";
import { classifyBranchSyncStatus } from "../lib/sync/branch-status";
import { buildCleanupPlan } from "../lib/sync/cleanup";
import { resolveReconcileDecision } from "../lib/sync/reconcile";
import { printBranchOutcome, printSyncSummary } from "../lib/sync/report";
import type {
	BranchSyncOutcome,
	SyncOptions,
	SyncResult,
} from "../lib/sync/types";
import { restack } from "./restack";

function isInteractiveShell(): boolean {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input, output });
	try {
		const answer = await rl.question(`${question} [Y/n] `);
		const normalized = answer.trim().toLowerCase();
		return normalized === "" || normalized === "y" || normalized === "yes";
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
		const answer = await rl.question("Select option: ");
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
		restack: rawOptions.restack ?? false,
		force: rawOptions.force ?? false,
		all: rawOptions.all ?? false,
		interactive: rawOptions.interactive ?? isInteractiveShell(),
	};

	const state = await readState(cwd);
	const originalBranch = await getCurrentBranch(cwd);

	const scopeStacks = options.all
		? state.stacks
		: (() => {
				const stack = findStackForBranch(state, originalBranch);
				if (!stack) {
					throw new DubError(
						`Branch '${originalBranch}' is not part of any stack. Run 'dub create' first.`,
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
				.filter((b) => b.type === "root")
				.map((b) => b.name),
		),
	);
	const stackBranches = Array.from(
		new Set(
			scopeStacks
				.flatMap((s) => s.branches)
				.filter((b) => b.type !== "root")
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

	try {
		console.log("🌲 Fetching branches from remote...");
		const toFetch = [...new Set([...roots, ...stackBranches])];
		if (toFetch.length > 0) {
			await fetchBranches(toFetch, cwd);
			result.fetched = toFetch;
		}

		for (const root of roots) {
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

		console.log("🧹 Cleaning up branches with merged/closed PRs...");
		const localTrackedBranches: string[] = [];
		for (const branch of stackBranches) {
			const hasLocal = await branchExists(branch, cwd);
			if (hasLocal) localTrackedBranches.push(branch);
		}
		const cleanupPlan = await buildCleanupPlan({
			branches: localTrackedBranches,
			getPrStatus: (branch) => getBranchPrLifecycleState(branch, cwd),
			isMergedIntoAnyRoot: async (branch) => {
				for (const root of roots) {
					const compareRef = rootHasRemote.get(root) ? `origin/${root}` : root;
					if (await isAncestor(branch, compareRef, cwd)) return true;
				}
				return false;
			},
		});
		const excludedFromSync = new Set<string>();
		for (const skipped of cleanupPlan.skipped) {
			if (skipped.reason === "commits-not-in-trunk") {
				excludedFromSync.add(skipped.branch);
				for (const child of getDescendants(scopeStacks, skipped.branch)) {
					excludedFromSync.add(child);
				}
			}
		}
		for (const branch of cleanupPlan.toDelete) {
			if (excludedFromSync.has(branch)) continue;
			let shouldDelete = options.force;
			if (!shouldDelete && options.interactive) {
				shouldDelete = await confirm(
					`Branch '${branch}' has merged/closed PR and is in trunk. Delete local branch?`,
				);
			}
			if (shouldDelete) {
				await checkoutBranch(roots[0] ?? originalBranch, cwd);
				await deleteBranch(branch, cwd);
				removeBranchFromState(scopeStacks, branch);
				result.cleaned.push(branch);
			}
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

		console.log("🔄 Syncing branches...");
		for (const branch of stackBranches) {
			if (result.cleaned.includes(branch) || excludedFromSync.has(branch))
				continue;

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
				? await getBranchPrSyncInfo(branch, cwd)
				: { state: "NONE" as const, baseRefName: null };
			const localParent = stateBranchMap.get(branch)?.parent ?? null;
			if (
				hasRemote &&
				hasLocal &&
				localSha !== remoteSha &&
				prSyncInfo.baseRefName &&
				localParent &&
				prSyncInfo.baseRefName !== localParent
			) {
				status = "needs-remote-sync";
			}

			if (status === "missing-remote") {
				outcome = {
					branch,
					status,
					action: "skipped",
					message: `⚠ Skipped '${branch}' (missing on remote).`,
				};
				result.branches.push(outcome);
				printBranchOutcome(outcome);
				continue;
			}

			if (status === "missing-local") {
				await checkoutRemoteBranch(branch, cwd);
				outcome = {
					branch,
					status,
					action: "synced",
					message: `✔ Restored '${branch}' from remote.`,
				};
				result.branches.push(outcome);
				printBranchOutcome(outcome);
				const restoredSha = await getRefSha(branch, cwd);
				await markBranchSynced(stateBranchMap, branch, restoredSha, cwd, {
					source: "sync",
					baseBranch: stateBranchMap.get(branch)?.parent ?? null,
				});
				continue;
			}

			if (status === "up-to-date") {
				outcome = {
					branch,
					status,
					action: "none",
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
						source: "sync",
						baseBranch: stateBranchMap.get(branch)?.parent ?? null,
					},
				);
				continue;
			}

			if (status === "updated-outside-dubstack-but-up-to-date") {
				outcome = {
					branch,
					status,
					action: "none",
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
						source: "imported",
						baseBranch: stateBranchMap.get(branch)?.parent ?? null,
					},
				);
				continue;
			}

			if (status === "needs-remote-sync-safe") {
				await hardResetBranchToRef(branch, remoteRef, cwd);
				outcome = {
					branch,
					status,
					action: "synced",
					message: `✔ Synced '${branch}' to remote head.`,
				};
				result.branches.push(outcome);
				printBranchOutcome(outcome);
				await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
					source: "sync",
					baseBranch: stateBranchMap.get(branch)?.parent ?? null,
				});
				continue;
			}

			if (status === "local-ahead") {
				outcome = {
					branch,
					status,
					action: "kept-local",
					message: `• Kept local '${branch}' (local commits ahead of remote).`,
				};
				result.branches.push(outcome);
				printBranchOutcome(outcome);
				continue;
			}

			if (status === "unsubmitted") {
				if (options.force) {
					await hardResetBranchToRef(branch, remoteRef, cwd);
					outcome = {
						branch,
						status,
						action: "synced",
						message: `✔ Synced unsubmitted branch '${branch}' to remote with --force.`,
					};
					await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
						source: "sync",
						baseBranch: localParent,
					});
				} else if (!options.interactive) {
					outcome = {
						branch,
						status,
						action: "skipped",
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
							action: "synced",
							message: `✔ Synced unsubmitted branch '${branch}' to remote.`,
						};
						await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
							source: "sync",
							baseBranch: localParent,
						});
					} else {
						outcome = {
							branch,
							status,
							action: "kept-local",
							message: `• Kept local unsubmitted branch '${branch}'.`,
						};
					}
				}
				result.branches.push(outcome);
				printBranchOutcome(outcome);
				continue;
			}

			if (status === "needs-remote-sync") {
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
						action: "synced",
						message: `✔ Synced '${branch}' to remote and adopted remote parent '${prSyncInfo.baseRefName ?? "unknown"}'.`,
					};
					await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
						source: "sync",
						baseBranch: prSyncInfo.baseRefName ?? localParent,
					});
				} else if (!options.interactive) {
					outcome = {
						branch,
						status,
						action: "skipped",
						message: `⚠ Skipped '${branch}' parent-mismatch sync (run interactively or with --force).`,
					};
				} else {
					const parentDecision = await choose(
						`Branch '${branch}' parent differs locally ('${localParent}') vs remote ('${prSyncInfo.baseRefName}').`,
						[
							{
								label: "Take remote version and remote parent",
								value: "remote",
							},
							{ label: "Keep local branch and parent", value: "local" },
							{ label: "Skip for now", value: "skip" },
						],
					);
					if (parentDecision === "remote") {
						await hardResetBranchToRef(branch, remoteRef, cwd);
						const stateBranch = stateBranchMap.get(branch);
						if (stateBranch && prSyncInfo.baseRefName) {
							stateBranch.parent = prSyncInfo.baseRefName;
						}
						outcome = {
							branch,
							status,
							action: "synced",
							message: `✔ Synced '${branch}' to remote and adopted remote parent.`,
						};
						await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
							source: "sync",
							baseBranch: prSyncInfo.baseRefName ?? localParent,
						});
					} else if (parentDecision === "local") {
						outcome = {
							branch,
							status,
							action: "kept-local",
							message: `• Kept local parent and local state for '${branch}'.`,
						};
					} else {
						outcome = {
							branch,
							status,
							action: "skipped",
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
				promptChoice: () =>
					choose(
						`Branch '${branch}' diverged from remote. How should sync proceed?`,
						[
							{
								label: "Take remote version (discard local divergence)",
								value: "take-remote",
							},
							{ label: "Keep local version", value: "keep-local" },
							{
								label: "Attempt reconciliation and keep local commits",
								value: "reconcile",
							},
							{ label: "Skip this branch", value: "skip" },
						],
					),
			});

			if (decision === "take-remote") {
				await hardResetBranchToRef(branch, remoteRef, cwd);
				outcome = {
					branch,
					status: "reconcile-needed",
					action: "synced",
					message: `✔ Synced '${branch}' to remote version.`,
				};
				await markBranchSynced(stateBranchMap, branch, remoteSha, cwd, {
					source: "sync",
					baseBranch: stateBranchMap.get(branch)?.parent ?? null,
				});
			} else if (decision === "keep-local") {
				outcome = {
					branch,
					status: "reconcile-needed",
					action: "kept-local",
					message: `• Kept local '${branch}' (remote divergence ignored).`,
				};
			} else if (decision === "reconcile") {
				const reconciled = await rebaseBranchOntoRef(branch, remoteRef, cwd);
				outcome = {
					branch,
					status: "reconcile-needed",
					action: reconciled ? "synced" : "kept-local",
					message: reconciled
						? `✔ Reconciled '${branch}' by rebasing local commits onto remote.`
						: `⚠ Could not auto-reconcile '${branch}'. Kept local state; reconcile manually.`,
				};
				if (reconciled) {
					const newSha = await getRefSha(branch, cwd);
					await markBranchSynced(stateBranchMap, branch, newSha, cwd, {
						source: "sync",
						baseBranch: stateBranchMap.get(branch)?.parent ?? null,
					});
				}
			} else {
				outcome = {
					branch,
					status: "reconcile-needed",
					action: "skipped",
					message: options.interactive
						? `⚠ Skipped '${branch}' by user choice.`
						: `⚠ Skipped '${branch}' (diverged from remote; rerun with --force or interactive).`,
				};
			}
			result.branches.push(outcome);
			printBranchOutcome(outcome);
		}

		await writeState(state, cwd);

		if (options.restack) {
			console.log("🥞 Restacking branches...");
			const rootsToRestack = options.all ? roots : [roots[0]].filter(Boolean);
			for (const root of rootsToRestack) {
				await checkoutBranch(root, cwd);
				const restackResult = await restack(cwd);
				if (restackResult.status === "conflict") {
					throw new DubError(
						`Sync paused: conflict while restacking '${restackResult.conflictBranch ?? "unknown"}'.\n` +
							"Recovery:\n" +
							"  1. Resolve conflicts and stage files.\n" +
							"  2. Run 'dub continue' to resume.\n" +
							"  3. Run 'dub abort' to cancel recovery and roll back progress.",
					);
				}
			}
			result.restacked = true;
		}
	} catch (error) {
		pendingError = await wrapSyncError(error, cwd);
	}

	const activeOperation = await detectActiveOperation(cwd).catch(() => "none");
	if (activeOperation === "none") {
		try {
			await checkoutBranch(originalBranch, cwd);
		} catch {
			if (!pendingError) {
				pendingError = new DubError(
					`Sync completed but could not restore original branch '${originalBranch}'.\n` +
						`Run 'git checkout ${originalBranch}' to return to your original context.`,
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
					error instanceof Error ? error.message : "Sync failed unexpectedly.",
				);
	const activeOperation = await detectActiveOperation(cwd).catch(() => "none");
	if (activeOperation === "none") {
		return baseError;
	}
	return new DubError(
		`${baseError.message}\n` +
			"Recovery:\n" +
			"  1. Run 'dub continue' after resolving conflicts.\n" +
			"  2. Run 'dub abort' to exit the in-progress operation safely.",
	);
}

async function markBranchSynced(
	branchMap: Map<string, Branch>,
	branchName: string,
	headSha: string | null,
	cwd: string,
	options: { source: "sync" | "imported"; baseBranch: string | null },
): Promise<void> {
	if (!headSha) return;
	const entry = branchMap.get(branchName);
	if (!entry) return;
	const priorBaseline = entry.last_submitted_version;
	const resolvedBaseBranch =
		options.baseBranch ?? priorBaseline?.base_branch ?? null;
	let resolvedBaseSha = priorBaseline?.base_sha ?? null;
	if (resolvedBaseBranch) {
		try {
			resolvedBaseSha = await getRefSha(resolvedBaseBranch, cwd);
		} catch {
			// Keep existing baseline SHA if base ref isn't currently resolvable.
		}
	}
	if (!resolvedBaseBranch || !resolvedBaseSha) return;
	entry.last_submitted_version = {
		head_sha: headSha,
		base_sha: resolvedBaseSha,
		base_branch: resolvedBaseBranch,
		version_number: priorBaseline?.version_number ?? null,
		source: options.source,
	};
	entry.last_synced_at = new Date().toISOString();
	entry.sync_source = options.source;
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
	for (const stack of stacks) {
		const deleted = stack.branches.find((b) => b.name === branch);
		if (!deleted) continue;
		const newParent = deleted.parent;
		for (const child of stack.branches) {
			if (child.parent === branch) {
				child.parent = newParent;
			}
		}
		stack.branches = stack.branches.filter((b) => b.name !== branch);
	}
}
