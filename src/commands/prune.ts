import { DubError } from "../lib/errors";
import {
	branchExists,
	fetchBranches,
	getCurrentBranch,
	remoteBranchExists,
} from "../lib/git";
import {
	type Branch,
	findStackForBranch,
	readState,
	type Stack,
	writeState,
} from "../lib/state";

export type PruneReason = "missing-local" | "missing-remote" | "missing-both";

export interface PruneEntry {
	branch: string;
	hasLocal: boolean;
	hasRemote: boolean;
	reason: PruneReason;
}

export interface PruneResult {
	applied: boolean;
	stale: PruneEntry[];
	removed: string[];
}

export async function prune(
	cwd: string,
	options: { apply?: boolean; all?: boolean; fetch?: boolean } = {},
): Promise<PruneResult> {
	const state = await readState(cwd);
	const currentBranch = await getCurrentBranch(cwd);
	const scopedStacks = resolveScopedStacks(state.stacks, currentBranch, {
		all: options.all ?? false,
	});
	const tracked = scopedStacks.flatMap((stack) =>
		stack.branches.filter((branch) => branch.type !== "root"),
	);

	const trackedNames = tracked.map((branch) => branch.name);
	if ((options.fetch ?? true) && trackedNames.length > 0) {
		try {
			await fetchBranches(trackedNames, cwd);
		} catch {
			// Best effort: prune can still proceed with current ref view.
		}
	}

	const stale: PruneEntry[] = [];
	for (const branch of tracked) {
		const hasLocal = await branchExists(branch.name, cwd);
		const hasRemote = await remoteBranchExists(branch.name, cwd);
		if (hasLocal && hasRemote) continue;
		stale.push({
			branch: branch.name,
			hasLocal,
			hasRemote,
			reason:
				!hasLocal && !hasRemote
					? "missing-both"
					: hasLocal
						? "missing-remote"
						: "missing-local",
		});
	}

	const removed: string[] = [];
	if (options.apply) {
		for (const entry of stale) {
			removeBranchFromState(scopedStacks, entry.branch);
			removed.push(entry.branch);
		}
		if (removed.length > 0) {
			await writeState(state, cwd);
		}
	}

	return {
		applied: options.apply ?? false,
		stale: stale.sort((a, b) => a.branch.localeCompare(b.branch)),
		removed: removed.sort(),
	};
}

function resolveScopedStacks(
	stacks: Stack[],
	currentBranch: string,
	options: { all: boolean },
): Stack[] {
	if (options.all) return stacks;
	const stack = findStackForBranch({ stacks }, currentBranch);
	if (!stack) {
		throw new DubError(
			`Branch '${currentBranch}' is not part of any stack. Run 'dub create' first.`,
		);
	}
	return [stack];
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
