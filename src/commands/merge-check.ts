import { DubError } from "../lib/errors";
import { getCurrentBranch } from "../lib/git";
import {
	checkGhAuth,
	ensureGhInstalled,
	getPr,
	getPrByNumber,
	getPrStateByNumber,
} from "../lib/github";
import { parseDubstackMetadata } from "../lib/pr-body";

export interface MergeCheckResult {
	ok: boolean;
	prNumber: number | null;
	reason: string;
}

export async function mergeCheck(
	cwd: string,
	options: { pr?: number; branch?: string } = {},
): Promise<MergeCheckResult> {
	await ensureGhInstalled();
	await checkGhAuth();

	const pr = options.pr
		? await getPrByNumber(options.pr, cwd)
		: await getPr(options.branch ?? (await getCurrentBranch(cwd)), cwd);

	if (!pr) {
		return {
			ok: true,
			prNumber: null,
			reason: "No open PR found. Merge-order check skipped.",
		};
	}

	const metadata = parseDubstackMetadata(pr.body);
	if (!metadata) {
		return {
			ok: true,
			prNumber: pr.number,
			reason: "No DubStack metadata found. Merge-order check skipped.",
		};
	}

	if (metadata.prev_pr == null) {
		return {
			ok: true,
			prNumber: pr.number,
			reason: "Root stack PR: merge order satisfied.",
		};
	}

	const previousState = await getPrStateByNumber(metadata.prev_pr, cwd);
	if (previousState !== "MERGED") {
		throw new DubError(
			`PR #${pr.number} cannot be merged yet. Previous stack PR #${metadata.prev_pr} is '${previousState}'. Merge it first.`,
		);
	}

	return {
		ok: true,
		prNumber: pr.number,
		reason: `Previous stack PR #${metadata.prev_pr} is merged; merge order satisfied.`,
	};
}
