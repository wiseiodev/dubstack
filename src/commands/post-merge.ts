import { DubError } from "../lib/errors";
import { checkoutBranch, getCurrentBranch } from "../lib/git";
import {
	checkGhAuth,
	ensureGhInstalled,
	getBranchPrLifecycleState,
	getBranchPrSyncInfo,
	retargetPrBase,
} from "../lib/github";
import {
	findStackForBranch,
	readState,
	type Stack,
	writeState,
} from "../lib/state";
import { restack } from "./restack";
import { submit } from "./submit";

export interface PostMergeResult {
	cleaned: string[];
	reparented: Array<{ branch: string; parent: string | null }>;
	retargeted: string[];
	restacked: boolean;
	submitted: boolean;
	submittedBranches: string[];
	dryRun: boolean;
}

export async function postMerge(
	cwd: string,
	options: {
		all?: boolean;
		dryRun?: boolean;
		restack?: boolean;
		submit?: boolean;
	} = {},
): Promise<PostMergeResult> {
	await ensureGhInstalled();
	await checkGhAuth();

	const dryRun = options.dryRun ?? false;
	const shouldRestack = options.restack ?? true;
	const shouldSubmit = options.submit ?? true;

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
	const workingStacks = dryRun ? structuredClone(scopeStacks) : scopeStacks;

	const result: PostMergeResult = {
		cleaned: [],
		reparented: [],
		retargeted: [],
		restacked: false,
		submitted: false,
		submittedBranches: [],
		dryRun,
	};
	let preferredBranch: string | null = null;

	for (const stack of workingStacks) {
		const mergedBottom = await getMergedBottomBranches(stack, cwd);
		for (const branchName of mergedBottom) {
			result.cleaned.push(branchName);
			const reparented = removeBranchFromStack(stack, branchName);
			result.reparented.push(...reparented);
		}
	}

	for (const stack of workingStacks) {
		for (const branch of stack.branches) {
			if (branch.type === "root" || !branch.parent) continue;
			const prInfo = await getBranchPrSyncInfo(branch.name, cwd);
			if (prInfo.state !== "OPEN") continue;
			if (prInfo.baseRefName === branch.parent) continue;
			result.retargeted.push(branch.name);
			if (!dryRun) {
				await retargetPrBase(branch.name, branch.parent, cwd);
			}
		}
	}

	if (!dryRun) {
		await writeState(state, cwd);
	}

	if (!dryRun && shouldRestack && workingStacks.some(hasNonRootBranches)) {
		for (const stack of workingStacks) {
			if (!hasNonRootBranches(stack)) continue;
			const root = stack.branches.find(
				(branch) => branch.type === "root",
			)?.name;
			if (!root) continue;
			await checkoutBranch(root, cwd);
			const restackResult = await restack(cwd);
			if (restackResult.status === "conflict") {
				throw new DubError(
					`Post-merge restack hit conflicts on '${restackResult.conflictBranch ?? "unknown"}'.\n` +
						"Resolve conflicts, then run 'dub continue'. Run 'dub abort' to cancel.",
				);
			}
		}
		result.restacked = true;
	}

	if (!dryRun) {
		preferredBranch = resolvePreferredBranch(
			workingStacks,
			originalBranch,
			scopeStacks,
		);
		if (preferredBranch) {
			await checkoutBranch(preferredBranch, cwd);
		}
	}

	if (!dryRun && shouldSubmit) {
		const submitResult = options.all
			? await submitAllStacks(cwd, workingStacks)
			: await submit(cwd, false, {
					path: "current",
					fix: true,
				});
		result.submitted = true;
		result.submittedBranches = submitResult.pushed;
	}
	if (!dryRun && preferredBranch) {
		await checkoutBranch(preferredBranch, cwd);
	}

	result.cleaned.sort();
	result.retargeted.sort();
	return result;
}

async function submitAllStacks(
	cwd: string,
	stacks: Stack[],
): Promise<{ pushed: string[] }> {
	const submitTargets = stacks
		.map(
			(stack) => stack.branches.find((branch) => branch.type !== "root")?.name,
		)
		.filter((branchName): branchName is string => Boolean(branchName));
	const pushed = new Set<string>();
	for (const branchName of submitTargets) {
		await checkoutBranch(branchName, cwd);
		const submitResult = await submit(cwd, false, {
			path: "current",
			fix: true,
		});
		for (const branch of submitResult.pushed) {
			pushed.add(branch);
		}
	}
	return { pushed: [...pushed].sort() };
}

async function getMergedBottomBranches(
	stack: Stack,
	cwd: string,
): Promise<string[]> {
	const branchMap = new Map(
		stack.branches.map((branch) => [branch.name, branch]),
	);
	const merged = new Set<string>();
	let changed = true;

	while (changed) {
		changed = false;
		for (const branch of stack.branches) {
			if (branch.type === "root") continue;
			if (merged.has(branch.name)) continue;

			const status = await getBranchPrLifecycleState(branch.name, cwd);
			if (status !== "MERGED") continue;

			const parent = branch.parent ? branchMap.get(branch.parent) : null;
			const parentIsSatisfied =
				!parent || parent.type === "root" || merged.has(parent.name);
			if (!parentIsSatisfied) continue;

			merged.add(branch.name);
			changed = true;
		}
	}

	return [...merged];
}

function removeBranchFromStack(
	stack: Stack,
	branchName: string,
): Array<{ branch: string; parent: string | null }> {
	const deleted = stack.branches.find((branch) => branch.name === branchName);
	if (!deleted) return [];
	const newParent = deleted.parent;

	const reparented: Array<{ branch: string; parent: string | null }> = [];
	for (const branch of stack.branches) {
		if (branch.parent !== branchName) continue;
		branch.parent = newParent;
		reparented.push({ branch: branch.name, parent: branch.parent });
	}
	stack.branches = stack.branches.filter(
		(branch) => branch.name !== branchName,
	);
	return reparented;
}

function hasNonRootBranches(stack: Stack): boolean {
	return stack.branches.some((branch) => branch.type !== "root");
}

function resolvePreferredBranch(
	workingStacks: Stack[],
	originalBranch: string,
	scopeStacks: Stack[],
): string | null {
	const inWorking = findStackForBranch(
		{ stacks: workingStacks },
		originalBranch,
	);
	if (inWorking) {
		return originalBranch;
	}

	const scopedIds = new Set(scopeStacks.map((stack) => stack.id));
	const preferredStack =
		workingStacks.find((stack) => scopedIds.has(stack.id)) ?? workingStacks[0];
	if (!preferredStack) return null;
	return (
		preferredStack.branches.find((branch) => branch.type !== "root")?.name ??
		preferredStack.branches.find((branch) => branch.type === "root")?.name ??
		null
	);
}
