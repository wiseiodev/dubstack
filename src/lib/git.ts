import { execa } from "execa";
import { DubError } from "./errors";

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

/**
 * Returns the subject line of the most recent commit on a branch.
 * @throws {DubError} If the branch has no commits.
 */
export async function getLastCommitMessage(
	branch: string,
	cwd: string,
): Promise<string> {
	try {
		const { stdout } = await execa(
			"git",
			["log", "-1", "--format=%s", branch],
			{ cwd },
		);
		const message = stdout.trim();
		if (!message) {
			throw new DubError(`Branch '${branch}' has no commits.`);
		}
		return message;
	} catch (error) {
		if (error instanceof DubError) throw error;
		throw new DubError(`Failed to read commit message for '${branch}'.`);
	}
}

/**
 * Pushes a branch to origin with `--force-with-lease`.
 * @throws {DubError} If the push fails.
 */
export async function pushBranch(branch: string, cwd: string): Promise<void> {
	try {
		await execa("git", ["push", "--force-with-lease", "origin", branch], {
			cwd,
		});
	} catch {
		throw new DubError(
			`Failed to push '${branch}'. The remote ref may have been updated by someone else.`,
		);
	}
}

/**
 * Stages all changes (tracked, untracked, and deletions).
 * @throws {DubError} If git add fails.
 */
export async function stageAll(cwd: string): Promise<void> {
	try {
		await execa("git", ["add", "-A"], { cwd });
	} catch {
		throw new DubError("Failed to stage changes.");
	}
}

/**
 * Checks whether there are staged changes ready to commit.
 *
 * `git diff --cached --quiet` exits with code 1 when changes exist
 * and code 0 when there are none.
 */
export async function hasStagedChanges(cwd: string): Promise<boolean> {
	try {
		await execa("git", ["diff", "--cached", "--quiet"], { cwd });
		return false;
	} catch (error: unknown) {
		const exitCode = (error as { exitCode?: number }).exitCode;
		if (exitCode === 1) return true;
		throw new DubError("Failed to check staged changes.");
	}
}

/**
 * Commits currently staged changes with the given message.
 * @throws {DubError} If the commit fails (e.g., nothing staged, hook rejection).
 */
export async function commitStaged(
	message: string,
	cwd: string,
): Promise<void> {
	try {
		await execa("git", ["commit", "-m", message], { cwd });
	} catch {
		throw new DubError(
			`Commit failed. Ensure there are staged changes and git hooks pass.`,
		);
	}
}

/**
 * Commits currently staged changes, opening the editor if no message is provided.
 * @param cwd - The working directory.
 * @param options - Commit options (message, noEdit).
 * @throws {DubError} If the commit fails.
 */
export async function commit(
	cwd: string,
	options?: { message?: string; noEdit?: boolean },
): Promise<void> {
	const args = ["commit"];
	if (options?.message) {
		args.push("-m", options.message);
	}
	if (options?.noEdit) {
		args.push("--no-edit");
	}

	try {
		await execa("git", args, { cwd, stdio: "inherit" });
	} catch {
		throw new DubError(
			"Commit failed. Ensure there are staged changes and git hooks pass.",
		);
	}
}

/**
 * Amends the previous commit with currently staged changes.
 * @param cwd - The working directory.
 * @param options - Amend options (message, noEdit).
 * @throws {DubError} If the amend fails.
 */
export async function amendCommit(
	cwd: string,
	options?: { message?: string; noEdit?: boolean },
): Promise<void> {
	const args = ["commit", "--amend"];
	if (options?.message) {
		args.push("-m", options.message);
	}
	if (options?.noEdit) {
		args.push("--no-edit");
	}

	try {
		await execa("git", args, { cwd, stdio: "inherit" });
	} catch (e) {
		throw new DubError(
			`Amend failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * Starts an interactive rebase from the given base.
 * Uses stdio: 'inherit' to allow user interaction.
 *
 * @param base - The commit or branch to rebase onto.
 * @param cwd - The working directory.
 * @throws {DubError} If rebase fails.
 */
export async function interactiveRebase(
	base: string,
	cwd: string,
): Promise<void> {
	try {
		await execa("git", ["rebase", "-i", base], { cwd, stdio: "inherit" });
	} catch {
		throw new DubError("Interactive rebase failed or was cancelled.");
	}
}

/**
 * Starts an interactive staging session (git add -p).
 * Uses stdio: 'inherit' to allow user interaction.
 *
 * @param cwd - The working directory.
 * @throws {DubError} If staging fails.
 */
export async function interactiveStage(cwd: string): Promise<void> {
	try {
		await execa("git", ["add", "-p"], { cwd, stdio: "inherit" });
	} catch {
		throw new DubError("Interactive staging failed.");
	}
}

/**
 * Stages all modified and deleted files (git add -u).
 *
 * @param cwd - The working directory.
 * @throws {DubError} If staging fails.
 */
export async function stageUpdate(cwd: string): Promise<void> {
	try {
		await execa("git", ["add", "-u"], { cwd });
	} catch {
		throw new DubError("Failed to stage updates.");
	}
}

/**
 * Returns the diff of changes.
 * @param staged - If true, shows staged changes (cached). If false, shows unstaged changes.
 */
export async function getDiff(cwd: string, staged: boolean): Promise<string> {
	try {
		const args = ["diff"];
		if (staged) args.push("--cached");
		const { stdout } = await execa("git", args, { cwd });
		return stdout;
	} catch {
		return "";
	}
}

/**
 * Returns a list of all local branch names.
 */
export async function listBranches(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await execa(
			"git",
			["branch", "--format=%(refname:short)"],
			{ cwd },
		);
		return stdout.trim().split("\n").filter(Boolean);
	} catch {
		throw new DubError("Failed to list branches.");
	}
}
