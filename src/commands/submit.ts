import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DubError } from "../lib/errors";
import {
	getBranchTip,
	getCurrentBranch,
	getLastCommitMessage,
	pushBranch,
} from "../lib/git";
import {
	checkGhAuth,
	createPr,
	ensureGhInstalled,
	getPr,
	type PrInfo,
	updatePrBody,
} from "../lib/github";
import {
	buildMetadataBlock,
	buildStackTable,
	composePrBody,
} from "../lib/pr-body";
import {
	type Branch,
	findStackForBranch,
	readState,
	topologicalOrder,
	writeState,
} from "../lib/state";

interface SubmitResult {
	pushed: string[];
	created: string[];
	updated: string[];
}

/**
 * Pushes branches in the current stack and creates/updates GitHub PRs.
 *
 * @param cwd - Working directory
 * @param dryRun - If true, prints what would happen without executing
 * @throws {DubError} If not in a stack, on root branch, stack is non-linear, or gh errors
 */
export async function submit(
	cwd: string,
	dryRun: boolean,
): Promise<SubmitResult> {
	await ensureGhInstalled();
	await checkGhAuth();

	const state = await readState(cwd);
	const currentBranch = await getCurrentBranch(cwd);
	const stack = findStackForBranch(state, currentBranch);

	if (!stack) {
		throw new DubError(
			`Branch '${currentBranch}' is not part of any stack. Run 'dub create' first.`,
		);
	}

	const ordered = topologicalOrder(stack);
	const currentEntry = ordered.find((b) => b.name === currentBranch);
	if (currentEntry?.type === "root") {
		throw new DubError(
			"Cannot submit from a root branch. Run 'dub up' or 'dub checkout <branch>' first.",
		);
	}

	const nonRootBranches = ordered.filter((b) => b.type !== "root");
	const rootBranch =
		ordered.find((branch) => branch.type === "root")?.name ?? "(unknown)";
	console.log(
		`Submitting ${nonRootBranches.length} branch(es) from '${currentBranch}' onto trunk '${rootBranch}'.`,
	);
	if (dryRun) {
		console.log("[dry-run] no branches will be pushed or mutated.");
	}

	validateLinearStack(ordered);

	const result: SubmitResult = { pushed: [], created: [], updated: [] };
	const prMap = new Map<string, PrInfo>();

	for (const branch of nonRootBranches) {
		if (dryRun) {
			console.log(`[dry-run] would push ${branch.name}`);
		} else {
			await pushBranch(branch.name, cwd);
		}
		result.pushed.push(branch.name);
	}

	for (const branch of nonRootBranches) {
		const base = branch.parent as string;

		if (dryRun) {
			console.log(`[dry-run] would check/create PR: ${branch.name} → ${base}`);
			continue;
		}

		const existing = await getPr(branch.name, cwd);
		if (existing) {
			prMap.set(branch.name, existing);
			result.updated.push(branch.name);
		} else {
			const title = await getLastCommitMessage(branch.name, cwd);
			const tmpFile = writeTempBody("");
			try {
				const created = await createPr(branch.name, base, title, tmpFile, cwd);
				prMap.set(branch.name, created);
				result.created.push(branch.name);
			} finally {
				cleanupTempFile(tmpFile);
			}
		}
	}

	if (!dryRun) {
		await updateAllPrBodies(nonRootBranches, prMap, stack.id, cwd);

		for (const branch of nonRootBranches) {
			const pr = prMap.get(branch.name);
			if (pr) {
				const stateBranch = stack.branches.find((b) => b.name === branch.name);
				if (stateBranch) {
					stateBranch.pr_number = pr.number;
					stateBranch.pr_link = pr.url;
					const headSha = await getBranchTip(branch.name, cwd);
					const baseSha = await getBranchTip(branch.parent as string, cwd);
					stateBranch.last_submitted_version = {
						head_sha: headSha,
						base_sha: baseSha,
						base_branch: branch.parent as string,
						version_number: null,
						source: "submit",
					};
					stateBranch.last_synced_at = new Date().toISOString();
					stateBranch.sync_source = "submit";
				}
			}
		}
		await writeState(state, cwd);
	}

	return result;
}

function validateLinearStack(ordered: Branch[]): void {
	const childCount = new Map<string, number>();
	for (const branch of ordered) {
		if (branch.parent) {
			childCount.set(branch.parent, (childCount.get(branch.parent) ?? 0) + 1);
		}
	}
	for (const [parent, count] of childCount) {
		if (count > 1) {
			throw new DubError(
				`Branch '${parent}' has ${count} children. ` +
					"Branching stacks are not supported by submit. " +
					"Ensure each branch has at most one child. " +
					"Use 'dub move' to linearize the stack before submitting.",
			);
		}
	}
}

async function updateAllPrBodies(
	branches: Branch[],
	prMap: Map<string, PrInfo>,
	stackId: string,
	cwd: string,
): Promise<void> {
	const tableEntries = new Map<string, { number: number; title: string }>();
	for (const branch of branches) {
		const pr = prMap.get(branch.name);
		if (pr) {
			tableEntries.set(branch.name, { number: pr.number, title: pr.title });
		}
	}

	for (let i = 0; i < branches.length; i++) {
		const branch = branches[i];
		const pr = prMap.get(branch.name);
		if (!pr) continue;

		const prevPr =
			i > 0 ? (prMap.get(branches[i - 1].name)?.number ?? null) : null;
		const nextPr =
			i < branches.length - 1
				? (prMap.get(branches[i + 1].name)?.number ?? null)
				: null;

		const stackTable = buildStackTable(branches, tableEntries, branch.name);
		const metadataBlock = buildMetadataBlock(
			stackId,
			pr.number,
			prevPr,
			nextPr,
			branch.name,
		);

		const existingBody = pr.body;
		const finalBody = composePrBody(existingBody, stackTable, metadataBlock);

		const tmpFile = writeTempBody(finalBody);
		try {
			await updatePrBody(pr.number, tmpFile, cwd);
		} finally {
			cleanupTempFile(tmpFile);
		}
	}
}

function writeTempBody(content: string): string {
	const tmpDir = os.tmpdir();
	const tmpFile = path.join(tmpDir, `dubstack-body-${Date.now()}.md`);
	fs.writeFileSync(tmpFile, content);
	return tmpFile;
}

function cleanupTempFile(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch {
		// Best-effort cleanup
	}
}
