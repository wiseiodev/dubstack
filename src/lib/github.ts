import { execa } from "execa";
import { DubError } from "./errors";

/** Details of a GitHub Pull Request. */
export interface PrInfo {
	number: number;
	url: string;
	title: string;
	body: string;
}

export type BranchPrLifecycleState = "OPEN" | "CLOSED" | "MERGED" | "NONE";

export interface BranchPrSyncInfo {
	state: BranchPrLifecycleState;
	baseRefName: string | null;
}

/**
 * Ensures the `gh` CLI is installed and available in PATH.
 * @throws {DubError} If `gh` is not found.
 */
export async function ensureGhInstalled(): Promise<void> {
	try {
		await execa("gh", ["--version"]);
	} catch {
		throw new DubError("gh CLI not found. Install it: https://cli.github.com");
	}
}

/**
 * Ensures the user is authenticated with `gh`.
 * @throws {DubError} If not authenticated.
 */
export async function checkGhAuth(): Promise<void> {
	try {
		await execa("gh", ["auth", "status"]);
	} catch {
		throw new DubError("Not authenticated with GitHub. Run 'gh auth login'.");
	}
}

/**
 * Fetches the open PR for a given head branch, if one exists.
 * @returns The PR info, or `null` if no open PR exists for that branch.
 */
export async function getPr(
	branch: string,
	cwd: string,
): Promise<PrInfo | null> {
	const { stdout } = await execa(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"number,url,title,body",
			"--jq",
			".[0]",
		],
		{ cwd },
	);

	const trimmed = stdout.trim();
	if (!trimmed || trimmed === "null") return null;

	try {
		return JSON.parse(trimmed) as PrInfo;
	} catch {
		throw new DubError(`Failed to parse PR info for branch '${branch}'.`);
	}
}

/**
 * Returns coarse lifecycle state of a PR associated with the branch head.
 */
export async function getBranchPrLifecycleState(
	branch: string,
	cwd: string,
): Promise<BranchPrLifecycleState> {
	const info = await getBranchPrSyncInfo(branch, cwd);
	return info.state;
}

/**
 * Returns PR lifecycle and base branch information for sync decisions.
 */
export async function getBranchPrSyncInfo(
	branch: string,
	cwd: string,
): Promise<BranchPrSyncInfo> {
	const { stdout } = await execa(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"all",
			"--json",
			"state,mergedAt,baseRefName",
			"--jq",
			".[0]",
		],
		{ cwd },
	);

	const trimmed = stdout.trim();
	if (!trimmed || trimmed === "null") {
		return { state: "NONE", baseRefName: null };
	}

	try {
		const parsed = JSON.parse(trimmed) as {
			state?: string;
			mergedAt?: string | null;
			baseRefName?: string | null;
		};
		if (parsed.mergedAt) {
			return {
				state: "MERGED",
				baseRefName: parsed.baseRefName ?? null,
			};
		}
		if (parsed.state === "CLOSED") {
			return {
				state: "CLOSED",
				baseRefName: parsed.baseRefName ?? null,
			};
		}
		if (parsed.state === "OPEN") {
			return {
				state: "OPEN",
				baseRefName: parsed.baseRefName ?? null,
			};
		}
		return { state: "NONE", baseRefName: parsed.baseRefName ?? null };
	} catch {
		throw new DubError(
			`Failed to parse PR lifecycle state for branch '${branch}'.`,
		);
	}
}

/**
 * Creates a new PR and returns its info.
 *
 * Parses the PR number from the URL printed to stdout by `gh pr create`,
 * avoiding an extra API round-trip.
 *
 * @param branch - Head branch
 * @param base - Base branch the PR merges into
 * @param title - PR title
 * @param bodyFile - Absolute path to a file containing the PR body
 */
export async function createPr(
	branch: string,
	base: string,
	title: string,
	bodyFile: string,
	cwd: string,
): Promise<PrInfo> {
	let stdout: string;
	try {
		const result = await execa(
			"gh",
			[
				"pr",
				"create",
				"--head",
				branch,
				"--base",
				base,
				"--title",
				title,
				"--body-file",
				bodyFile,
			],
			{ cwd },
		);
		stdout = result.stdout;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("403") || message.includes("insufficient")) {
			throw new DubError(
				"GitHub token lacks required permissions. Run 'gh auth login' with the 'repo' scope.",
			);
		}
		throw new DubError(`Failed to create PR for '${branch}': ${message}`);
	}

	const url = stdout.trim();
	const numberMatch = url.match(/\/pull\/(\d+)$/);
	if (!numberMatch) {
		throw new DubError(`Unexpected output from 'gh pr create': ${url}`);
	}

	return {
		number: Number.parseInt(numberMatch[1], 10),
		url,
		title,
		body: "",
	};
}

/**
 * Updates a PR's body using a file.
 * @param prNumber - The PR number to update
 * @param bodyFile - Absolute path to a file containing the new body
 */
export async function updatePrBody(
	prNumber: number,
	bodyFile: string,
	cwd: string,
): Promise<void> {
	try {
		await execa(
			"gh",
			["pr", "edit", String(prNumber), "--body-file", bodyFile],
			{ cwd },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("403") || message.includes("insufficient")) {
			throw new DubError(
				"GitHub token lacks required permissions. Run 'gh auth login' with the 'repo' scope.",
			);
		}
		throw new DubError(`Failed to update PR #${prNumber}: ${message}`);
	}
}
