import { execa } from "execa";
import { DubError } from "./errors.js";

/**
 * Checks whether the given directory is inside a git repository.
 * @returns `true` if inside a git worktree, `false` otherwise. Never throws.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execa(
			"git",
			["rev-parse", "--is-inside-work-tree"],
			{ cwd },
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

/**
 * Returns the absolute path to the repository root.
 * @throws {DubError} If not inside a git repository.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], {
			cwd,
		});
		return stdout.trim();
	} catch {
		throw new DubError(
			"Not a git repository. Run this command inside a git repo.",
		);
	}
}

/**
 * Returns the name of the currently checked-out branch.
 * @throws {DubError} If HEAD is detached or the repo has no commits.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
	try {
		const { stdout } = await execa(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd },
		);
		const branch = stdout.trim();
		if (branch === "HEAD") {
			throw new DubError(
				"HEAD is detached. Checkout a branch before running this command.",
			);
		}
		return branch;
	} catch (error) {
		if (error instanceof DubError) throw error;
		throw new DubError(
			"Repository has no commits. Make at least one commit first.",
		);
	}
}

/**
 * Checks whether a branch with the given name exists locally.
 * @returns `true` if the branch exists, `false` otherwise. Never throws.
 */
export async function branchExists(
	name: string,
	cwd: string,
): Promise<boolean> {
	try {
		await execa("git", ["rev-parse", "--verify", `refs/heads/${name}`], {
			cwd,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Creates a new branch and switches to it.
 * @throws {DubError} If a branch with that name already exists.
 */
export async function createBranch(name: string, cwd: string): Promise<void> {
	if (await branchExists(name, cwd)) {
		throw new DubError(`Branch '${name}' already exists.`);
	}
	await execa("git", ["checkout", "-b", name], { cwd });
}

/**
 * Switches to an existing branch.
 * @throws {DubError} If the branch does not exist.
 */
export async function checkoutBranch(name: string, cwd: string): Promise<void> {
	try {
		await execa("git", ["checkout", name], { cwd });
	} catch {
		throw new DubError(`Branch '${name}' not found.`);
	}
}

/**
 * Deletes a local branch forcefully. Used by undo to remove created branches.
 * @throws {DubError} If the branch does not exist.
 */
export async function deleteBranch(name: string, cwd: string): Promise<void> {
	try {
		await execa("git", ["branch", "-D", name], { cwd });
	} catch {
		throw new DubError(`Failed to delete branch '${name}'. It may not exist.`);
	}
}

/**
 * Force-moves a branch pointer to a specific commit SHA.
 * Used by undo to reset branches to their pre-operation tips.
 */
export async function forceBranchTo(
	name: string,
	sha: string,
	cwd: string,
): Promise<void> {
	try {
		const current = await getCurrentBranch(cwd).catch(() => null);
		if (current === name) {
			await execa("git", ["reset", "--hard", sha], { cwd });
		} else {
			await execa("git", ["branch", "-f", name, sha], { cwd });
		}
	} catch (error) {
		if (error instanceof DubError) throw error;
		throw new DubError(`Failed to reset branch '${name}' to ${sha}.`);
	}
}

/**
 * Checks whether the working tree is clean (no uncommitted changes).
 * @returns `true` if clean (no output from `git status --porcelain`).
 */
export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
	const { stdout } = await execa("git", ["status", "--porcelain"], { cwd });
	return stdout.trim() === "";
}

/**
 * Performs `git rebase --onto` to move a branch from one base to another.
 *
 * @param newBase - The commit/branch to rebase onto
 * @param oldBase - The old base commit to replay from
 * @param branch - The branch being rebased
 * @throws {DubError} If a merge conflict occurs during rebase
 */
export async function rebaseOnto(
	newBase: string,
	oldBase: string,
	branch: string,
	cwd: string,
): Promise<void> {
	try {
		await execa("git", ["rebase", "--onto", newBase, oldBase, branch], { cwd });
	} catch {
		throw new DubError(
			`Conflict while restacking '${branch}'.\n` +
				"  Resolve conflicts, stage changes, then run: dub restack --continue",
		);
	}
}

/**
 * Continues an in-progress rebase after conflicts have been resolved.
 * @throws {DubError} If the rebase continue fails.
 */
export async function rebaseContinue(cwd: string): Promise<void> {
	try {
		await execa("git", ["rebase", "--continue"], {
			cwd,
			env: { GIT_EDITOR: "true" },
		});
	} catch {
		throw new DubError(
			"Failed to continue rebase. Ensure all conflicts are resolved and staged.",
		);
	}
}

/**
 * Returns the merge-base (common ancestor) commit SHA of two branches.
 */
export async function getMergeBase(
	a: string,
	b: string,
	cwd: string,
): Promise<string> {
	try {
		const { stdout } = await execa("git", ["merge-base", a, b], { cwd });
		return stdout.trim();
	} catch {
		throw new DubError(
			`Could not find common ancestor between '${a}' and '${b}'.`,
		);
	}
}

/**
 * Returns the commit SHA at the tip of a branch.
 * @throws {DubError} If the branch does not exist.
 */
export async function getBranchTip(name: string, cwd: string): Promise<string> {
	try {
		const { stdout } = await execa("git", ["rev-parse", name], { cwd });
		return stdout.trim();
	} catch {
		throw new DubError(`Branch '${name}' not found.`);
	}
}
